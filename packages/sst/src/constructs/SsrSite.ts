import path from "path";
import url from "url";
import fs from "fs";
import glob from "glob";
import crypto from "crypto";
import spawn from "cross-spawn";
import { execSync } from "child_process";

import { Construct } from "constructs";
import {
  Fn,
  Token,
  Duration as CdkDuration,
  CfnOutput,
  RemovalPolicy,
  CustomResource,
} from "aws-cdk-lib";
import { Bucket, BucketProps, IBucket } from "aws-cdk-lib/aws-s3";
import { Role, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  Function,
  Code,
  Runtime,
  FunctionUrlAuthType,
  FunctionProps,
} from "aws-cdk-lib/aws-lambda";
import {
  HostedZone,
  IHostedZone,
  ARecord,
  AaaaRecord,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import {
  Distribution,
  ICachePolicy,
  BehaviorOptions,
  ViewerProtocolPolicy,
  AllowedMethods,
  CachedMethods,
  LambdaEdgeEventType,
  CachePolicy,
  CacheQueryStringBehavior,
  CacheHeaderBehavior,
  CacheCookieBehavior,
} from "aws-cdk-lib/aws-cloudfront";
import { ICertificate } from "aws-cdk-lib/aws-certificatemanager";
import { AwsCliLayer } from "aws-cdk-lib/lambda-layer-awscli";
import { S3Origin, HttpOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import { CloudFrontTarget } from "aws-cdk-lib/aws-route53-targets";

import { App } from "./App.js";
import { Stack } from "./Stack.js";
import { Logger } from "../logger.js";
import { SSTConstruct, isCDKConstruct } from "./Construct.js";
import { EdgeFunction } from "./EdgeFunction.js";
import {
  BaseSiteDomainProps,
  BaseSiteReplaceProps,
  BaseSiteCdkDistributionProps,
  getBuildCmdEnvironment,
} from "./BaseSite.js";
import { HttpsRedirect } from "./cdk/website-redirect.js";
import { DnsValidatedCertificate } from "./cdk/dns-validated-certificate.js";
import { Size } from "./util/size.js";
import { Duration } from "./util/duration.js";
import { Permissions, attachPermissionsToRole } from "./util/permission.js";
import {
  ENVIRONMENT_PLACEHOLDER,
  FunctionBindingProps,
  getParameterPath,
} from "./util/functionBinding.js";
import { SiteEnv } from "../site-env.js";
import { useProject } from "../project.js";
import { VisibleError } from "../error.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export type SsrBuildConfig = {
  serverBuildOutputFile: string;
  clientBuildOutputDir: string;
  clientBuildVersionedSubDir: string;
};

export interface SsrDomainProps extends BaseSiteDomainProps {}
export interface SsrSiteReplaceProps extends BaseSiteReplaceProps {}
export interface SsrCdkDistributionProps extends BaseSiteCdkDistributionProps {}
export interface SsrSiteProps {
  /**
   * Bind resources for the function
   *
   * @example
   * ```js
   * new Function(stack, "Function", {
   *   handler: "src/function.handler",
   *   bind: [STRIPE_KEY, bucket],
   * })
   * ```
   */
  bind?: SSTConstruct[];
  /**
   * Path to the directory where the app is located.
   * @default "."
   */
  path?: string;
  /**
   * The command for building the website
   * @default `npm run build`
   * @example
   * ```js
   * buildCommand: "yarn build",
   * ```
   */
  buildCommand?: string;
  /**
   * The customDomain for this website. SST supports domains that are hosted
   * either on [Route 53](https://aws.amazon.com/route53/) or externally.
   *
   * Note that you can also migrate externally hosted domains to Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   *
   * @example
   * ```js
   * customDomain: "domain.com",
   * ```
   *
   * ```js
   * customDomain: {
   *   domainName: "domain.com",
   *   domainAlias: "www.domain.com",
   *   hostedZone: "domain.com"
   * },
   * ```
   */
  customDomain?: string | SsrDomainProps;
  /**
   * The SSR function is deployed to Lambda in a single region. Alternatively, you can enable this option to deploy to Lambda@Edge.
   * @default false
   */
  edge?: boolean;
  /**
   * The execution timeout in seconds for SSR function.
   * @default 10 seconds
   * @example
   * ```js
   * timeout: "5 seconds",
   * ```
   */
  timeout?: number | Duration;
  /**
   * The amount of memory in MB allocated for SSR function.
   * @default 1024 MB
   * @example
   * ```js
   * memorySize: "512 MB",
   * ```
   */
  memorySize?: number | Size;
  /**
   * The runtime environment for the SSR function.
   * @default nodejs18.x
   * @example
   * ```js
   * runtime: "nodejs16.x",
   * ```
   */
  runtime?: "nodejs14.x" | "nodejs16.x" | "nodejs18.x";
  /**
   * Attaches the given list of permissions to the SSR function. Configuring this property is equivalent to calling `attachPermissions()` after the site is created.
   * @example
   * ```js
   * permissions: ["ses"]
   * ```
   */
  permissions?: Permissions;
  /**
   * An object with the key being the environment variable name.
   *
   * @example
   * ```js
   * environment: {
   *   API_URL: api.url,
   *   USER_POOL_CLIENT: auth.cognitoUserPoolClient.userPoolClientId,
   * },
   * ```
   */
  environment?: Record<string, string>;
  dev?: {
    /**
     * When running `sst dev, site is not deployed. This is to ensure `sst dev` can start up quickly.
     * @default false
     * @example
     * ```js
     * dev: {
     *   deploy: true
     * }
     * ```
     */
    deploy?: boolean;
  };
  /**
   * While deploying, SST waits for the CloudFront cache invalidation process to finish. This ensures that the new content will be served once the deploy command finishes. However, this process can sometimes take more than 5 mins. For non-prod environments it might make sense to pass in `false`. That'll skip waiting for the cache to invalidate and speed up the deploy process.
   * @default false
   */
  waitForInvalidation?: boolean;
  cdk?: {
    /**
     * Allows you to override default id for this construct.
     */
    id?: string;
    /**
     * Allows you to override default settings this construct uses internally to ceate the bucket
     */
    bucket?: BucketProps | IBucket;
    /**
     * Pass in a value to override the default settings this construct uses to
     * create the CDK `Distribution` internally.
     */
    distribution?: SsrCdkDistributionProps;
    /**
     * Override the CloudFront cache policy properties for responses from the
     * server rendering Lambda.
     *
     * @note The default cache policy that is used in the abscene of this property
     * is one that performs no caching of the server response.
     */
    serverCachePolicy?: ICachePolicy;
    server?: Pick<
      FunctionProps,
      | "vpc"
      | "vpcSubnets"
      | "securityGroups"
      | "allowAllOutbound"
      | "allowPublicSubnet"
      | "architecture"
    >;
  };
}

/**
 * The `SsrSite` construct is a higher level CDK construct that makes it easy to create modern web apps with Server Side Rendering capabilities.
 * @example
 * Deploys an Astro app in the `web` directory.
 *
 * ```js
 * new SsrSite(stack, "site", {
 *   path: "web",
 * });
 * ```
 */
export class SsrSite extends Construct implements SSTConstruct {
  public readonly id: string;
  protected props: Omit<SsrSiteProps, "path"> & {
    path: string;
    timeout: number | Duration;
    memorySize: number | Size;
  };
  private doNotDeploy: boolean;
  protected buildConfig: SsrBuildConfig;
  private serverLambdaForEdge?: EdgeFunction;
  protected serverLambdaForRegional?: Function;
  private bucket: Bucket;
  private distribution: Distribution;
  private hostedZone?: IHostedZone;
  private certificate?: ICertificate;

  constructor(scope: Construct, id: string, props?: SsrSiteProps) {
    super(scope, props?.cdk?.id || id);

    const app = scope.node.root as App;
    this.id = id;
    this.props = {
      path: ".",
      waitForInvalidation: false,
      runtime: "nodejs18.x",
      timeout: "10 seconds",
      memorySize: "1024 MB",
      ...props,
    };
    this.doNotDeploy = (app.local || app.skipBuild) && !this.props.dev?.deploy;

    this.validateSiteExists();
    this.registerSiteEnvironment();

    if (this.doNotDeploy) {
      // @ts-ignore
      this.buildConfig = this.bucket = this.distribution = null;
      return;
    }

    const cliLayer = new AwsCliLayer(this, "AwsCliLayer");

    // Build app
    this.buildConfig = this.initBuildConfig();
    this.buildApp();

    // Create Bucket which will be utilised to contain the statics
    this.bucket = this.createS3Bucket();

    // Create Server functions
    if (this.props.edge) {
      this.serverLambdaForEdge = this.createFunctionForEdge();
      this.createFunctionPermissionsForEdge();
    } else {
      this.serverLambdaForRegional = this.createFunctionForRegional();
      this.createFunctionPermissionsForRegional();
    }

    // Create Custom Domain
    this.validateCustomDomainSettings();
    this.hostedZone = this.lookupHostedZone();
    this.certificate = this.createCertificate();

    // Create S3 Deployment
    const assets = this.createS3Assets();
    const assetFileOptions = this.createS3AssetFileOptions();
    const s3deployCR = this.createS3Deployment(
      cliLayer,
      assets,
      assetFileOptions
    );

    // Create CloudFront
    this.validateCloudFrontDistributionSettings();
    this.distribution = this.props.edge
      ? this.createCloudFrontDistributionForEdge()
      : this.createCloudFrontDistributionForRegional();
    this.distribution.node.addDependency(s3deployCR);

    // Invalidate CloudFront
    const invalidationCR = this.createCloudFrontInvalidation(cliLayer);
    invalidationCR.node.addDependency(this.distribution);

    // Connect Custom Domain to CloudFront Distribution
    this.createRoute53Records();
  }

  /////////////////////
  // Public Properties
  /////////////////////

  /**
   * The CloudFront URL of the website.
   */
  public get url(): string | undefined {
    if (this.doNotDeploy) {
      return;
    }

    return `https://${this.distribution.distributionDomainName}`;
  }

  /**
   * If the custom domain is enabled, this is the URL of the website with the
   * custom domain.
   */
  public get customDomainUrl(): string | undefined {
    if (this.doNotDeploy) {
      return;
    }

    const { customDomain } = this.props;
    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return `https://${customDomain}`;
    } else {
      return `https://${customDomain.domainName}`;
    }
  }

  /**
   * The internally created CDK resources.
   */
  public get cdk() {
    if (this.doNotDeploy) {
      throw new VisibleError(
        `Cannot access CDK resources for the "${this.node.id}" site in dev mode`
      );
    }

    return {
      function: this.serverLambdaForRegional,
      bucket: this.bucket,
      distribution: this.distribution,
      hostedZone: this.hostedZone,
      certificate: this.certificate,
    };
  }

  /////////////////////
  // Public Methods
  /////////////////////

  /**
   * Attaches the given list of permissions to allow the Astro server side
   * rendering to access other AWS resources.
   *
   * @example
   * ```js
   * site.attachPermissions(["sns"]);
   * ```
   */
  public attachPermissions(permissions: Permissions): void {
    if (this.serverLambdaForRegional) {
      attachPermissionsToRole(
        this.serverLambdaForRegional.role as Role,
        permissions
      );
    }

    this.serverLambdaForEdge?.attachPermissions(permissions);
  }

  /** @internal */
  public getConstructMetadata() {
    return {
      type: "SsrSite" as const,
      data: {
        customDomainUrl: this.customDomainUrl,
      },
    };
  }

  /** @internal */
  public getFunctionBinding(): FunctionBindingProps {
    const app = this.node.root as App;
    return {
      clientPackage: "site",
      variables: {
        url: {
          // Do not set real value b/c we don't want to make the Lambda function
          // depend on the Site. B/c often the site depends on the Api, causing
          // a CloudFormation circular dependency if the Api and the Site belong
          // to different stacks.
          environment: this.doNotDeploy ? "" : ENVIRONMENT_PLACEHOLDER,
          parameter: this.customDomainUrl || this.url,
        },
      },
      permissions: {
        "ssm:GetParameters": [
          `arn:${Stack.of(this).partition}:ssm:${app.region}:${
            app.account
          }:parameter${getParameterPath(this, "url")}`,
        ],
      },
    };
  }

  /////////////////////
  // Build App
  /////////////////////

  protected initBuildConfig(): SsrBuildConfig {
    return {
      serverBuildOutputFile: "placeholder",
      clientBuildOutputDir: "placeholder",
      clientBuildVersionedSubDir: "placeholder",
    };
  }

  private buildApp() {
    const app = this.node.root as App;
    if (!app.isRunningSSTTest()) {
      this.runBuild();
    }
    this.validateBuildOutput();
  }

  protected validateBuildOutput() {
    const serverBuildFile = path.join(
      this.props.path,
      this.buildConfig.serverBuildOutputFile
    );
    if (!fs.existsSync(serverBuildFile)) {
      throw new Error(`No server build output found at "${serverBuildFile}"`);
    }
  }

  private runBuild() {
    const {
      path: sitePath,
      buildCommand: rawBuildCommand,
      environment,
    } = this.props;
    const defaultCommand = "npm run build";
    const buildCommand = rawBuildCommand || defaultCommand;

    if (buildCommand === defaultCommand) {
      // Ensure that the site has a build script defined
      if (!fs.existsSync(path.join(sitePath, "package.json"))) {
        throw new Error(`No package.json found at "${sitePath}".`);
      }
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(sitePath, "package.json")).toString()
      );
      if (!packageJson.scripts || !packageJson.scripts.build) {
        throw new Error(
          `No "build" script found within package.json in "${sitePath}".`
        );
      }
    }

    // Run build
    Logger.debug(`Running "${buildCommand}" script`);
    try {
      execSync(buildCommand, {
        cwd: sitePath,
        stdio: "inherit",
        env: {
          ...process.env,
          ...getBuildCmdEnvironment(environment),
        },
      });
    } catch (e) {
      throw new Error(
        `There was a problem building the "${this.node.id}" StaticSite.`
      );
    }
  }

  /////////////////////
  // Bundle S3 Assets
  /////////////////////

  private createS3Assets(): Asset[] {
    // Create temp folder, clean up if exists
    const zipOutDir = path.resolve(
      path.join(
        useProject().paths.artifacts,
        `Site-${this.node.id}-${this.node.addr}`
      )
    );
    fs.rmSync(zipOutDir, { recursive: true, force: true });

    // Create zip files
    const app = this.node.root as App;
    const script = path.resolve(__dirname, "../support/base-site-archiver.mjs");
    const fileSizeLimit = app.isRunningSSTTest()
      ? // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore: "sstTestFileSizeLimitOverride" not exposed in props
        this.props.sstTestFileSizeLimitOverride || 200
      : 200;
    const result = spawn.sync(
      "node",
      [
        script,
        path.join(this.props.path, this.buildConfig.clientBuildOutputDir),
        zipOutDir,
        `${fileSizeLimit}`,
      ],
      {
        stdio: "inherit",
      }
    );
    if (result.status !== 0) {
      throw new Error(`There was a problem generating the assets package.`);
    }

    // Create S3 Assets for each zip file
    const assets = [];
    for (let partId = 0; ; partId++) {
      const zipFilePath = path.join(zipOutDir, `part${partId}.zip`);
      if (!fs.existsSync(zipFilePath)) {
        break;
      }
      assets.push(
        new Asset(this, `Asset${partId}`, {
          path: zipFilePath,
        })
      );
    }
    return assets;
  }

  private createS3AssetFileOptions() {
    // Build file options
    const fileOptions = [];
    const clientPath = path.join(
      this.props.path,
      this.buildConfig.clientBuildOutputDir
    );
    for (const item of fs.readdirSync(clientPath)) {
      // Versioned files will be cached for 1 year (immutable) both at
      // CDN and browser level.
      if (item === this.buildConfig.clientBuildVersionedSubDir) {
        fileOptions.push({
          exclude: "*",
          include: `${this.buildConfig.clientBuildVersionedSubDir}/*`,
          cacheControl: "public,max-age=31536000,immutable",
        });
      }
      // Un-versioned files will be cached for 1 year at the CDN level.
      // But not at the browser level. CDN cache will be invalidated on deploy.
      else {
        const itemPath = path.join(clientPath, item);
        fileOptions.push({
          exclude: "*",
          include: fs.statSync(itemPath).isDirectory()
            ? `${item}/*`
            : `${item}`,
          cacheControl: "public,max-age=0,s-maxage=31536000,must-revalidate",
        });
      }
    }
    return fileOptions;
  }

  private createS3Bucket(): Bucket {
    const { cdk } = this.props;

    // cdk.bucket is an imported construct
    if (cdk?.bucket && isCDKConstruct(cdk?.bucket)) {
      return cdk.bucket as Bucket;
    }
    // cdk.bucket is a prop
    else {
      const bucketProps = cdk?.bucket as BucketProps;
      return new Bucket(this, "S3Bucket", {
        publicReadAccess: true,
        autoDeleteObjects: true,
        removalPolicy: RemovalPolicy.DESTROY,
        ...bucketProps,
      });
    }
  }

  private createS3Deployment(
    cliLayer: AwsCliLayer,
    assets: Asset[],
    fileOptions: { exclude: string; include: string; cacheControl: string }[]
  ): CustomResource {
    // Create a Lambda function that will be doing the uploading
    const uploader = new Function(this, "S3Uploader", {
      code: Code.fromAsset(
        path.join(__dirname, "../support/base-site-custom-resource")
      ),
      layers: [cliLayer],
      runtime: Runtime.PYTHON_3_7,
      handler: "s3-upload.handler",
      timeout: CdkDuration.minutes(15),
      memorySize: 1024,
    });
    this.bucket.grantReadWrite(uploader);
    assets.forEach((asset) => asset.grantRead(uploader));

    // Create the custom resource function
    const handler = new Function(this, "S3Handler", {
      code: Code.fromAsset(
        path.join(__dirname, "../support/base-site-custom-resource")
      ),
      layers: [cliLayer],
      runtime: Runtime.PYTHON_3_7,
      handler: "s3-handler.handler",
      timeout: CdkDuration.minutes(15),
      memorySize: 1024,
      environment: {
        UPLOADER_FUNCTION_NAME: uploader.functionName,
      },
    });
    this.bucket.grantReadWrite(handler);
    uploader.grantInvoke(handler);

    // Create custom resource
    return new CustomResource(this, "S3Deployment", {
      serviceToken: handler.functionArn,
      resourceType: "Custom::SSTBucketDeployment",
      properties: {
        Sources: assets.map((asset) => ({
          BucketName: asset.s3BucketName,
          ObjectKey: asset.s3ObjectKey,
        })),
        DestinationBucketName: this.bucket.bucketName,
        FileOptions: (fileOptions || []).map(
          ({ exclude, include, cacheControl }) => {
            return [
              "--exclude",
              exclude,
              "--include",
              include,
              "--cache-control",
              cacheControl,
            ];
          }
        ),
        ReplaceValues: this.getS3ContentReplaceValues(),
      },
    });
  }

  /////////////////////
  // Bundle Lambda Server
  /////////////////////

  protected createFunctionForRegional(): Function {
    return {} as Function;
  }

  protected createFunctionForEdge(): EdgeFunction {
    return {} as EdgeFunction;
  }

  private createFunctionPermissionsForRegional() {
    const { permissions } = this.props;

    this.bucket.grantReadWrite(this.serverLambdaForRegional!.role!);
    if (permissions) {
      attachPermissionsToRole(
        this.serverLambdaForRegional!.role as Role,
        permissions
      );
    }
  }

  private createFunctionPermissionsForEdge() {
    this.bucket.grantReadWrite(this.serverLambdaForEdge!.role);
  }

  /////////////////////
  // CloudFront Distribution
  /////////////////////

  private validateCloudFrontDistributionSettings() {
    const { cdk } = this.props;
    if (cdk?.distribution?.certificate) {
      throw new Error(
        `Do not configure the "cfDistribution.certificate". Use the "customDomain" to configure the domain certificate.`
      );
    }
    if (cdk?.distribution?.domainNames) {
      throw new Error(
        `Do not configure the "cfDistribution.domainNames". Use the "customDomain" to configure the domain name.`
      );
    }
  }

  protected createCloudFrontDistributionForRegional(): Distribution {
    const { cdk } = this.props;
    const cfDistributionProps = cdk?.distribution || {};
    const s3Origin = new S3Origin(this.bucket);

    return new Distribution(this, "Distribution", {
      // these values can be overwritten by cfDistributionProps
      defaultRootObject: "",
      // Override props.
      ...cfDistributionProps,
      // these values can NOT be overwritten by cfDistributionProps
      domainNames: this.buildDistributionDomainNames(),
      certificate: this.certificate,
      defaultBehavior: this.buildDistributionDefaultBehaviorForRegional(),
      additionalBehaviors: {
        ...this.buildDistributionStaticFileBehaviors(s3Origin),
        ...(cfDistributionProps.additionalBehaviors || {}),
      },
    });
  }

  private createCloudFrontDistributionForEdge(): Distribution {
    const { cdk } = this.props;
    const cfDistributionProps = cdk?.distribution || {};
    const s3Origin = new S3Origin(this.bucket);

    return new Distribution(this, "Distribution", {
      // these values can be overwritten by cfDistributionProps
      defaultRootObject: "",
      // Override props.
      ...cfDistributionProps,
      // these values can NOT be overwritten by cfDistributionProps
      domainNames: this.buildDistributionDomainNames(),
      certificate: this.certificate,
      defaultBehavior: this.buildDistributionDefaultBehaviorForEdge(s3Origin),
      additionalBehaviors: {
        ...this.buildDistributionStaticFileBehaviors(s3Origin),
        ...(cfDistributionProps.additionalBehaviors || {}),
      },
    });
  }

  protected buildDistributionDomainNames(): string[] {
    const { customDomain } = this.props;
    const domainNames = [];
    if (!customDomain) {
      // no domain
    } else if (typeof customDomain === "string") {
      domainNames.push(customDomain);
    } else {
      domainNames.push(customDomain.domainName);
      if (customDomain.alternateNames) {
        if (!customDomain.cdk?.certificate)
          throw new Error(
            "Certificates for alternate domains cannot be automatically created. Please specify certificate to use"
          );
        domainNames.push(...customDomain.alternateNames);
      }
    }
    return domainNames;
  }

  private buildDistributionDefaultBehaviorForRegional(): BehaviorOptions {
    const { cdk } = this.props;
    const cfDistributionProps = cdk?.distribution || {};

    const fnUrl = this.serverLambdaForRegional!.addFunctionUrl({
      authType: FunctionUrlAuthType.NONE,
    });

    return {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      origin: new HttpOrigin(Fn.parseDomainName(fnUrl.url)),
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy:
        cdk?.serverCachePolicy ?? this.createCloudFrontServerCachePolicy(),
      ...(cfDistributionProps.defaultBehavior || {}),
    };
  }

  private buildDistributionDefaultBehaviorForEdge(
    origin: S3Origin
  ): BehaviorOptions {
    const { cdk } = this.props;
    const cfDistributionProps = cdk?.distribution || {};

    return {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      origin,
      allowedMethods: AllowedMethods.ALLOW_ALL,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy:
        cdk?.serverCachePolicy ?? this.createCloudFrontServerCachePolicy(),
      ...(cfDistributionProps.defaultBehavior || {}),
      // concatenate edgeLambdas
      edgeLambdas: [
        {
          includeBody: true,
          eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
          functionVersion: this.serverLambdaForEdge!.currentVersion,
        },
        ...(cfDistributionProps.defaultBehavior?.edgeLambdas || []),
      ],
    };
  }

  protected buildDistributionStaticFileBehaviors(
    origin: S3Origin
  ): Record<string, BehaviorOptions> {
    const { cdk } = this.props;

    // Create additional behaviours for statics
    const staticBehaviourOptions: BehaviorOptions = {
      viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      origin,
      allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy: CachePolicy.CACHING_OPTIMIZED,
    };

    // Add behaviour for public folder statics (excluding build)
    const staticsBehaviours: Record<string, BehaviorOptions> = {};
    const publicDir = path.join(
      this.props.path,
      this.buildConfig.clientBuildOutputDir
    );
    for (const item of fs.readdirSync(publicDir)) {
      if (fs.statSync(path.join(publicDir, item)).isDirectory()) {
        staticsBehaviours[`${item}/*`] = staticBehaviourOptions;
      } else {
        staticsBehaviours[item] = staticBehaviourOptions;
      }
    }

    return staticsBehaviours;
  }

  protected createCloudFrontServerCachePolicy(): CachePolicy {
    return new CachePolicy(this, "ServerCache", {
      queryStringBehavior: CacheQueryStringBehavior.all(),
      headerBehavior: CacheHeaderBehavior.none(),
      cookieBehavior: CacheCookieBehavior.all(),
      defaultTtl: CdkDuration.days(0),
      maxTtl: CdkDuration.days(365),
      minTtl: CdkDuration.days(0),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      comment: "SST server response cache policy",
    });
  }

  private createCloudFrontInvalidation(cliLayer: AwsCliLayer): CustomResource {
    // Create a Lambda function that will be doing the invalidation
    const invalidator = new Function(this, "CloudFrontInvalidator", {
      code: Code.fromAsset(
        path.join(__dirname, "../support/base-site-custom-resource")
      ),
      layers: [cliLayer],
      runtime: Runtime.PYTHON_3_7,
      handler: "cf-invalidate.handler",
      timeout: CdkDuration.minutes(15),
      memorySize: 1024,
    });

    // Grant permissions to invalidate CF Distribution
    invalidator.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cloudfront:GetInvalidation",
          "cloudfront:CreateInvalidation",
        ],
        resources: ["*"],
      })
    );

    return new CustomResource(this, "CloudFrontInvalidation", {
      serviceToken: invalidator.functionArn,
      resourceType: "Custom::SSTCloudFrontInvalidation",
      properties: {
        BuildId: this.generateBuildId(),
        DistributionId: this.distribution.distributionId,
        // TODO: Ignore the browser build path as it may speed up invalidation
        DistributionPaths: ["/*"],
        WaitForInvalidation: this.props.waitForInvalidation,
      },
    });
  }

  /////////////////////
  // Custom Domain
  /////////////////////

  protected validateCustomDomainSettings() {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return;
    }

    if (customDomain.isExternalDomain === true) {
      if (!customDomain.cdk?.certificate) {
        throw new Error(
          `A valid certificate is required when "isExternalDomain" is set to "true".`
        );
      }
      if (customDomain.domainAlias) {
        throw new Error(
          `Domain alias is only supported for domains hosted on Amazon Route 53. Do not set the "customDomain.domainAlias" when "isExternalDomain" is enabled.`
        );
      }
      if (customDomain.hostedZone) {
        throw new Error(
          `Hosted zones can only be configured for domains hosted on Amazon Route 53. Do not set the "customDomain.hostedZone" when "isExternalDomain" is enabled.`
        );
      }
    }
  }

  protected lookupHostedZone(): IHostedZone | undefined {
    const { customDomain } = this.props;

    // Skip if customDomain is not configured
    if (!customDomain) {
      return;
    }

    let hostedZone;

    if (typeof customDomain === "string") {
      hostedZone = HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain,
      });
    } else if (customDomain.cdk?.hostedZone) {
      hostedZone = customDomain.cdk.hostedZone;
    } else if (typeof customDomain.hostedZone === "string") {
      hostedZone = HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.hostedZone,
      });
    } else if (typeof customDomain.domainName === "string") {
      // Skip if domain is not a Route53 domain
      if (customDomain.isExternalDomain === true) {
        return;
      }

      hostedZone = HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.domainName,
      });
    } else {
      hostedZone = customDomain.hostedZone;
    }

    return hostedZone;
  }

  private createCertificate(): ICertificate | undefined {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    let acmCertificate;

    // HostedZone is set for Route 53 domains
    if (this.hostedZone) {
      if (typeof customDomain === "string") {
        acmCertificate = new DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain,
          hostedZone: this.hostedZone,
          region: "us-east-1",
        });
      } else if (customDomain.cdk?.certificate) {
        acmCertificate = customDomain.cdk.certificate;
      } else {
        acmCertificate = new DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain.domainName,
          hostedZone: this.hostedZone,
          region: "us-east-1",
        });
      }
    }
    // HostedZone is NOT set for non-Route 53 domains
    else {
      if (typeof customDomain !== "string") {
        acmCertificate = customDomain.cdk?.certificate;
      }
    }

    return acmCertificate;
  }

  protected createRoute53Records(): void {
    const { customDomain } = this.props;

    if (!customDomain || !this.hostedZone) {
      return;
    }

    let recordName;
    let domainAlias;
    if (typeof customDomain === "string") {
      recordName = customDomain;
    } else {
      recordName = customDomain.domainName;
      domainAlias = customDomain.domainAlias;
    }

    // Create DNS record
    const recordProps = {
      recordName,
      zone: this.hostedZone,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    };
    new ARecord(this, "AliasRecord", recordProps);
    new AaaaRecord(this, "AliasRecordAAAA", recordProps);

    // Create Alias redirect record
    if (domainAlias) {
      new HttpsRedirect(this, "Redirect", {
        zone: this.hostedZone,
        recordNames: [domainAlias],
        targetDomain: recordName,
      });
    }
  }

  /////////////////////
  // Helper Functions
  /////////////////////

  private getS3ContentReplaceValues() {
    const replaceValues: SsrSiteReplaceProps[] = [];

    Object.entries(this.props.environment || {})
      .filter(([, value]) => Token.isUnresolved(value))
      .forEach(([key, value]) => {
        const token = `{{ ${key} }}`;
        replaceValues.push(
          {
            files: "**/*.html",
            search: token,
            replace: value,
          },
          {
            files: "**/*.js",
            search: token,
            replace: value,
          }
        );
      });
    return replaceValues;
  }

  private validateSiteExists() {
    const { path: sitePath } = this.props;
    if (!fs.existsSync(sitePath)) {
      throw new Error(`No site found at "${path.resolve(sitePath)}"`);
    }
  }

  private registerSiteEnvironment() {
    for (const [key, value] of Object.entries(this.props.environment || {})) {
      const outputId = `SstSiteEnv_${key}`;
      const output = new CfnOutput(this, outputId, { value });
      SiteEnv.append({
        path: this.props.path,
        output: Stack.of(this).getLogicalId(output),
        environment: key,
        stack: Stack.of(this).stackName,
      });
    }
  }

  protected generateBuildId(): string {
    // We will generate a hash based on the contents of the "public" folder
    // which will be used to indicate if we need to invalidate our CloudFront
    // cache. As the browser build files are always uniquely hash in their
    // filenames according to their content we can ignore the browser build
    // files.

    // The below options are needed to support following symlinks when building zip files:
    // - nodir: This will prevent symlinks themselves from being copied into the zip.
    // - follow: This will follow symlinks and copy the files within.
    const globOptions = {
      dot: true,
      nodir: true,
      follow: true,
      ignore: [`${this.buildConfig.clientBuildVersionedSubDir}/**`],
      cwd: path.resolve(this.props.path, this.buildConfig.clientBuildOutputDir),
    };
    const files = glob.sync("**", globOptions);
    const hash = crypto.createHash("sha1");
    for (const file of files) {
      hash.update(file);
    }
    const buildId = hash.digest("hex");

    Logger.debug(`Generated build ID ${buildId}`);

    return buildId;
  }
}

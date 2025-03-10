import { remove, cmd, patch, extend, extract, install } from "create-sst";
export default [
  extend("presets/base/monorepo"),
  patch({
    file: "package.json",
    operations: [
      { op: "add", path: "/overrides", value: {} },
      { op: "add", path: "/overrides/graphql", value: "16.5.0" },
    ],
  }),
  // Vanilla Extract doesn't support Vite 3 yet
  // https://github.com/seek-oss/vanilla-extract/issues/760
  cmd({
    cmd: "npx create-vite@2.9.5 web --template=react-ts",
    cwd: "packages",
  }),
  extract(),
  install({
    packages: ["ulid"],
    path: "packages/core",
  }),
  install({
    packages: ["@pothos/core", "graphql", "ulid"],
    path: "packages/functions",
  }),
  install({
    packages: ["@types/aws-lambda"],
    path: "packages/functions",
  }),
  install({
    packages: ["react-router-dom", "urql", "graphql"],
    path: "packages/web",
  }),
  install({
    packages: ["sst"],
    path: "packages/web",
    dev: true,
  }),
  patch({
    file: "packages/web/package.json",
    operations: [{ op: "add", path: "/scripts/dev", value: "sst env vite" }],
  }),
  patch({
    file: "packages/web/package.json",
    operations: [
      {
        op: "add",
        path: "/dependencies/@@@app~1graphql",
        value: "0.0.0",
      },
    ],
  }),
  install({
    packages: ["wonka", "@genql/runtime"],
    path: "packages/graphql",
  }),
  install({
    packages: ["@genql/cli"],
    dev: true,
    path: "packages/graphql",
  }),
  cmd({
    cmd: "npx @genql/cli --output ./genql --schema ./schema.graphql --esm",
    cwd: "packages/graphql",
  }),
  install({
    packages: [
      "@vanilla-extract/css",
      "@vanilla-extract/vite-plugin",
      "react-icons",
    ],
    path: "packages/web",
  }),
  remove("packages/web/src/App.tsx"),
  remove("packages/web/src/App.css"),
  remove("packages/web/src/logo.svg"),
  remove("packages/web/src/index.css"),
  remove("packages/web/src/favicon.svg"),
  remove("packages/web/public/vite.svg"),
  remove("packages/web/src/assets/react.svg"),
];

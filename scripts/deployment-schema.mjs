export const DEPLOYMENT_SCHEMA = Object.freeze({
  releaseManifest: 1,
  protectedDeployment: 4,
  authorization: 2,
  hostReceipt: 4,
  rollbackSources: 4,
  promotionReady: 2,
  cutoverReceipt: 2,
});
export const DEPLOYMENT_PURPOSE = Object.freeze({ production: "production", integration: "release-integration" });

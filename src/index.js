export { createMarketMap } from "./app/createMarketMap.js";
export { createMarketMapExperience } from "./app/createMarketMapExperience.js";
export { getMarketMapShell, renderMarketMapShell } from "./app/marketMapShell.js";
export {
  MarketDataClient,
  MarketDataClientError,
  validateMarketDataEnvelope,
} from "./api/MarketDataClient.js";
export { BatchRequestPlanner } from "./api/BatchRequestPlanner.js";
export { FixedHistory } from "./core/FixedHistory.js";
export { Lifecycle } from "./core/Lifecycle.js";
export { RefreshCoordinator } from "./core/RefreshCoordinator.js";
export { StateManager } from "./core/StateManager.js";
export { UpdateScheduler } from "./core/UpdateScheduler.js";
export { NewsController } from "./controllers/NewsController.js";
export { BoardNewsView } from "./ui/views/BoardNewsView.js";
export { formatNewsTimestamp } from "./ui/models/newsPresentation.js";
export {
  ASSET_CLASSES,
  buildAssetPresentationPolicy,
  legacyCompatiblePresentationInput,
  resolvePresentationState,
  resolveRequestState,
} from "./ui/models/assetPresentationPolicy.js";
export {
  displaySymbolOf,
  formatInstrumentValue,
  presentationSymbol,
  supportsPriceUnit,
} from "./ui/models/instrumentFormat.js";
export { buildTileViewModel } from "./ui/models/tileViewModel.js";
export { buildDetailViewModel } from "./ui/models/detailAssetViewModel.js";
export { selectEligibleBoardCohort } from "./ui/models/boardCohorts.js";
export {
  DEFAULT_WORKSPACE_ID,
  getWorkspace,
  STARTER_INSTRUMENTS,
  STARTER_WORKSPACE,
  WORKSPACES,
} from "./data/workspaces.js";

export const MARKETMAP_VERSION = "0.1.0";

import { TimingService } from "services/TimingService";
import { PinataIpfsClient } from "./services/PinataIpfsClient";
import { Aurelia } from "aurelia-framework";
import * as environment from "../config/environment.json";
import { PLATFORM } from "aurelia-pal";
import { AllowedNetworks, EthereumService, isCeloNetworkLike, isLocalhostNetwork, isNetworkPresent, Networks } from "services/EthereumService";
import { EventConfigException } from "services/GeneralEvents";
import { ConsoleLogService } from "services/ConsoleLogService";
import { ContractsService } from "services/ContractsService";
import { EventAggregator } from "aurelia-event-aggregator";
import { SeedService } from "services/SeedService";
import { IpfsService } from "services/IpfsService";
import { GeoBlockService } from "services/GeoBlockService";
import { HTMLSanitizer } from "aurelia-templating-resources";
import DOMPurify from "dompurify";
import { TokenService } from "services/TokenService";
import { ContractsDeploymentProvider } from "services/ContractsDeploymentProvider";
import { EthereumServiceTesting } from "services/EthereumServiceTesting";
import { LbpManagerService } from "services/LbpManagerService";
import { Seed } from "entities/Seed";
import { LbpManager } from "entities/LbpManager";
import { Lbp } from "entities/Lbp";
import { Vault } from "entities/Vault";
import { BalancerService } from "services/BalancerService";
import { LaunchService } from "services/LaunchService";
import { BrowserStorageService } from "services/BrowserStorageService";

/**
 * Temp change to Celo as default mainnet
 * https://app.shortcut.com/curvelabs/story/2109/change-default-network-to-celo-temporary
*/
const DEFAULT_MAINNET_NETWORK = Networks.Celo;
const DEFAULT_TESTNET_NETWORK = Networks.Goerli;
const networkFromEnv = process.env.NETWORK as AllowedNetworks;
const isMainnet = networkFromEnv === Networks.Mainnet;
const inDev = process.env.NODE_ENV === "development";

export function configure(aurelia: Aurelia): void {
  // Note, this Cypress hack has to be at the very start.
  // Reason: Imports in eg. /resources/index, where EthereumService is imported to
  //   /binding-behaviors results in EthereumService not being mocked "in time" for Cypress.
  if ((window as any).Cypress) {
    /**
     * Mock wallet connection
     */
    aurelia.use.singleton(EthereumService, EthereumServiceTesting);
    (window as any).Cypress.eventAggregator = aurelia.container.get(EventAggregator);
  }

  aurelia.use
    .standardConfiguration()
    .feature(PLATFORM.moduleName("resources/index"))
    .plugin(PLATFORM.moduleName("aurelia-animator-css"))
    .plugin(PLATFORM.moduleName("aurelia-dialog"), (configuration) => {
      // custom configuration
      configuration.settings.keyboard = false;
    });

  aurelia.use.singleton(HTMLSanitizer, DOMPurify);

  const storageService = new BrowserStorageService;
  const network = getLegalNetwork(storageService.lsGet<AllowedNetworks>("network"));

  if (inDev) {
    aurelia.use.developmentLogging(); // everything
  } else {
    aurelia.use.developmentLogging("warn"); // only errors and warnings
  }

  if (environment.testing) {
    aurelia.use.plugin(PLATFORM.moduleName("aurelia-testing"));
  }

  aurelia.start().then(async () => {
    aurelia.container.get(ConsoleLogService);
    try {
      /**
       * otherwise singleton is the default
       */
      aurelia.container.registerTransient(Seed);
      aurelia.container.registerTransient(LbpManager);
      aurelia.container.registerTransient(Lbp);
      aurelia.container.registerTransient(Vault);

      const ethereumService = aurelia.container.get(EthereumService);

      const targetNetwork = handleNetworkFromLocalStorage(network);
      storageService.lsSet("network", targetNetwork);
      ethereumService.initialize(targetNetwork);

      ContractsDeploymentProvider.initialize(EthereumService.targetedNetwork);

      aurelia.container.get(ContractsService);

      TimingService.start("TokenService Initialization");
      const tokenService = aurelia.container.get(TokenService);
      await tokenService.initialize();
      TimingService.end("TokenService Initialization");

      TimingService.start("LaunchService Initialization");
      const launchService = aurelia.container.get(LaunchService);
      await launchService.initialize();
      TimingService.end("LaunchService Initialization");

      // TimingService.start("BalancerService Initialization");
      // TODO: Remove condition once Symmetric Subgraph is being used
      if (!isCeloNetworkLike(network) && !isLocalhostNetwork()) {
        const balancerService = aurelia.container.get(BalancerService);
        balancerService.initialize();
      }
      // TimingService.end("BalancerService Initialization");

      TimingService.start("GeoBlockService Initialization");
      const geoBlockService = aurelia.container.get(GeoBlockService);
      await geoBlockService.initialize();
      TimingService.end("GeoBlockService Initialization");

      const ipfsService = aurelia.container.get(IpfsService);
      ipfsService.initialize(aurelia.container.get(PinataIpfsClient));

      const seedService = aurelia.container.get(SeedService);
      seedService.initialize();

      if ((window as any).Cypress) {
        (window as any).Cypress.SeedService = aurelia.container.get(SeedService);
      }

      if (!isCeloNetworkLike(network) && !isLocalhostNetwork()) {
        const lbpManagerService = aurelia.container.get(LbpManagerService);
        lbpManagerService.initialize();
      }
    } catch (ex) {
      const eventAggregator = aurelia.container.get(EventAggregator);
      eventAggregator.publish("handleException", new EventConfigException("Error initializing the app", ex));
      alert(`Sorry, unable to initialize, possibly could not connect to ethereum: ${ex.message}. If your VPN is enabled, please turn it off and refresh the page.`);
    }
    aurelia.setRoot(PLATFORM.moduleName("app"));
  });
}

function getLegalNetwork(locallyStoredNetwork: AllowedNetworks) {
  if (!isNetworkPresent(locallyStoredNetwork)) {
    return networkFromEnv;
  }

  const invalidlyStoredTestnet = isMainnet
    && [Networks.Alfajores, Networks.Kovan, Networks.Goerli, Networks.Localhost].includes(locallyStoredNetwork);
  if (invalidlyStoredTestnet) {
    return DEFAULT_MAINNET_NETWORK;
  }

  const invalidlyStoredMainnet = !isMainnet
    && [Networks.Mainnet, Networks.Celo, Networks.Arbitrum].includes(locallyStoredNetwork);
  if (invalidlyStoredMainnet) {
    return DEFAULT_TESTNET_NETWORK;
  }

  const legalNetwork = isLocalhostNetwork(networkFromEnv) ? Networks.Localhost : locallyStoredNetwork;
  return legalNetwork;
}

function handleNetworkFromLocalStorage(network: Networks) {
  let targetNetwork;
  if (isNetworkPresent(network)) {
    targetNetwork = network;
  } else {
    const devNetwork = isLocalhostNetwork(networkFromEnv) ? Networks.Localhost : Networks.Goerli;
    targetNetwork = isMainnet ? DEFAULT_MAINNET_NETWORK : devNetwork;
  }
  return targetNetwork;
}

# General Architecture

Yukibana is built on the Eclipse Theia Platform, an open source Typescript
framework to develop IDEs. This framework is built on a similar struture to
VSCode and is compatible with all VSCode extensions.
Yukibana is constructed from the ground up, only adding needed features on top
of the bare editor.

The following sections describe the overall architecture of Yukibana,
as well as the core elements of Theia. For documentation about how specific
features are implemented, see [features.md](features.md).

## Theia's components

The IDE is basically an Electron app. This means it can be built both as
a web-app and a standalone desktop application. The whole architecture is organized
into three distinct parts:
- [Backend / node modules](#backend-modules)
- [Frontend / browser modules](#frontend-modules)

When the app is launched, backend modules are first loaded to initialize the server-side.
Only one instance of the backend can run at once. Then, any window that is opened
launches the frontend modules.

For more information, please refer to Theia's [own documentation](https://theia-ide.org/docs/),
in particular the [Services and Contributions](https://theia-ide.org/docs/services_and_contributions/)
and [Architecture Overview](https://theia-ide.org/docs/architecture/) sections.

### Backend modules

Backend modules form the IDE's central process, which manages server-side extensions
such as build servers and LSPs. They are initialized on first startup of the app
and only run in a single backend instance. They can provide REST endpoints
to communicate with frontend modules, or use the provided RPC system.

### Frontend modules

Frontend modules are loaded in each IDE window. They provide editor features
such as widgets, commands, source actions, menus, etc.

### Contributions

Each module can provide several contributions. Contributions are grouped by purpose,
such as commands, keybindings, menus, quick access actions, etc.
Each contribution is a class extending its specific Contribution kind.
Depency injection (DI) is used to manage access between contributions, services
and providers, thanks to [inversify](https://inversify.io/).
More information on DI in [Dependency Injection](#dependency-injection).

### Dependency Injection

When a module is defined (frontend or backend), it must bind its contributions
to symbols in the DI container so that they can be used and injected in other modules.

For example:

```ts
export default new ContainerModule((bind, unbind, isBound, rebind) => {
    bind(CleanupFrontendContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(CleanupFrontendContribution);
});
```

This module registers a frontend contribution implemented by
the `CleanupFrontendContribution` class. It binds it to itself so that it can be
referenced by its class symbol, and uses the singleton scope.
This ensures the class is only initialized once upon its first resolution and
the instance is then reused for all other references. Finally, the contribution
is bound to `FrontendApplicationContribution` so that it is loaded with
all other frontend contributions and appended to the list of registered
frontend contributions.

For a class to be injectable, it must be decorated with the `@injectable()` annotation:

```ts
@injectable()
export class MyContribution {
    ...
}
```

To inject dependencies in other classes, you can use the `@inject()` annotation:

```ts
@injectable()
export class MyOtherContribution {
    @inject(MyContribution) protected readonly myContribution: MyContribution;
    @inject(ILogger) @named('yukibana:MyOtherContribution') protected readonly logger: ILogger; 
}
```

## Yukibana's architecture

This project has the following layout

```bash
Yukibana
├── ide
│   ├── browser                 # Browser-app specific config and resources
│   ├── common                  # Helpers used across extensions (not an extension itself)
│   ├── configs                 # The IDE's TypeScript and Vitest configuration
│   ├── e2e                     # E2E tests
│   ├── electron                # Electron-app specific config and resources
│   ├── extensions
│   │   ├── yukibana            # Main extension, where customization features are implemented
│   │   ├── yukibana-cloud      # Extension to log in to Yukibana Cloud and download and update projects
│   │   ├── yukibana-launcher   # Extension to create .desktop file and CLI command
│   │   ├── yukibana-product    # Extension to set window icon on Linux
│   │   ├── yukibana-submission # Extension to manage submission (preparation and upload)
│   │   ├── yukibana-telemetry  # Extension to report telemetry
│   │   └── langs               # Language extensions (Scala)
│   └── scripts                 # The root's build, start, package and download:plugins commands
├── cloud                       # Yukibana Cloud: the web app (web), the database (db), local development (dev)
└── packages
    ├── client                  # The library the extensions and the CLI share (@yukibana/client)
    └── cli                     # The yukibana command
```

### Configuration

Multiple parts of the IDE can be configured at build-time:
- Builtin VSCode extensions:
  - defined in [`ide/package.json`](../ide/package.json)
    thanks to `theiaPlugins` and `theiaPluginsExcludeIds`

  - downloaded in the `ide/plugins` folder by `pnpm download:plugins`

- Builtin Theia Plugins:
  - added as node dependencies to [`ide/browser/package.json`](../ide/browser/package.json)
    and [`ide/electron/package.json`](../ide/electron/package.json)

  - automatically built and loaded

- General IDE configuration (e.g. splash screen):
  - defined in each app's `package.json`, in the `theia` parameter

- Electron build options:
  - defined in [`ide/electron/electron-builder.yml`](../ide/electron/electron-builder.yml)

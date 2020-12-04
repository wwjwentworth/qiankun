import { noop } from 'lodash';
import { mountRootParcel, ParcelConfigObject, registerApplication, start as startSingleSpa } from 'single-spa';
import { FrameworkConfiguration, FrameworkLifeCycles, LoadableApp, MicroApp, RegistrableApp } from './interfaces';
import { loadApp, ParcelConfigObjectGetter } from './loader';
import { doPrefetchStrategy } from './prefetch';
import { Deferred, getContainer, getXPathForElement, toArray } from './utils';

let microApps: RegistrableApp[] = [];

// eslint-disable-next-line import/no-mutable-exports
export let frameworkConfiguration: FrameworkConfiguration = {};
const frameworkStartedDefer = new Deferred<void>();

export function registerMicroApps<T extends object = {}>(
  apps: Array<RegistrableApp<T>>,
  lifeCycles?: FrameworkLifeCycles<T>,
) {
  // 防止微应用重新注册
  const unregisteredApps = apps.filter((app) => !microApps.some((registeredApp) => registeredApp.name === app.name));
  // 所有的微应用 = 已注册 + 未注册
  microApps = [...microApps, ...unregisteredApps];

  unregisteredApps.forEach((app) => {
    // name: 微应用名称
    // activeRule: 激活的路由
    // props：主应用传递过来的值
    const { name, activeRule, loader = noop, props, ...appConfig } = app;

    // 核心，负责加载微应用，然后一堆处理，最后返回mout,bootstrap,update,unmount这几个声明周期钩子函数
    registerApplication({
      name, // 微应用名称
      app: async () => {
        loader(true);
        await frameworkStartedDefer.promise;

        const { mount, ...otherMicroAppConfigs } = await loadApp(
          { name, props, ...appConfig },
          frameworkConfiguration,
          lifeCycles
        );

        return {
          mount: [async () => loader(true), ...toArray(mount), async () => loader(false)],
          ...otherMicroAppConfigs,
        };
      },
      // 微应用被激活的条件
      activeWhen: activeRule,
      // 主应用传递给微应用的props
      customProps: props,
    });
  });
}

const appConfigPromiseGetterMap = new Map<string, Promise<ParcelConfigObjectGetter>>();

// 手动加载微应用
export function loadMicroApp<T extends object = {}>(
  app: LoadableApp<T>,
  configuration?: FrameworkConfiguration,
  lifeCycles?: FrameworkLifeCycles<T>,
): MicroApp {
  const { props, name } = app;

  const getContainerXpath = (container: string | HTMLElement): string | void => {
    const containerElement = getContainer(container);
    if (containerElement) {
      return getXPathForElement(containerElement, document);
    }

    return undefined;
  };

  const wrapParcelConfigForRemount = (config: ParcelConfigObject): ParcelConfigObject => {
    return {
      ...config,
      // empty bootstrap hook which should not run twice while it calling from cached micro app
      bootstrap: () => Promise.resolve(),
    };
  };

  /**
   * using name + container xpath as the micro app instance id,
   * it means if you rendering a micro app to a dom which have been rendered before,
   * the micro app would not load and evaluate its lifecycles again
   */
  const memorizedLoadingFn = async (): Promise<ParcelConfigObject> => {
    const { $$cacheLifecycleByAppName } = configuration ?? frameworkConfiguration;
    const container = 'container' in app ? app.container : undefined;

    if (container) {
      // using appName as cache for internal experimental scenario
      if ($$cacheLifecycleByAppName) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(name);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }

      const xpath = getContainerXpath(container);
      if (xpath) {
        const parcelConfigGetterPromise = appConfigPromiseGetterMap.get(`${name}-${xpath}`);
        if (parcelConfigGetterPromise) return wrapParcelConfigForRemount((await parcelConfigGetterPromise)(container));
      }
    }

    const parcelConfigObjectGetterPromise = loadApp(app, configuration ?? frameworkConfiguration, lifeCycles);

    if (container) {
      if ($$cacheLifecycleByAppName) {
        appConfigPromiseGetterMap.set(name, parcelConfigObjectGetterPromise);
      } else {
        const xpath = getContainerXpath(container);
        if (xpath) appConfigPromiseGetterMap.set(`${name}-${xpath}`, parcelConfigObjectGetterPromise);
      }
    }

    return (await parcelConfigObjectGetterPromise)(container);
  };

  return mountRootParcel(memorizedLoadingFn, { domElement: document.createElement('div'), ...props });
}

export function start(opts: FrameworkConfiguration = {}) {
  frameworkConfiguration = {
    prefetch: true,  // 是否预加载，默认为预加载
    singular: true,  // 是否开启单利模式，默认开启
    sandbox: true,   // 是否开启沙箱模式，默认开启
    ...opts
  };
  const {
    prefetch,
    sandbox,
    singular,
    urlRerouteOnly,
    ...importEntryOpts
  } = frameworkConfiguration;

  // 预加载
  if (prefetch) {
    // 执行预加载策略，参数是微应用列表，预加载策略
    doPrefetchStrategy(microApps, prefetch, importEntryOpts);
  }

  if (sandbox) {
    // 非代理模式下不允许使用沙箱模式
    if (!window.Proxy) {
      console.warn('[qiankun] Miss window.Proxy, proxySandbox will degenerate into snapshotSandbox');
      frameworkConfiguration.sandbox = typeof sandbox === 'object' ? { ...sandbox, loose: true } : { loose: true };
      // 如果开始沙箱模式，会强制使用单利模式
      if (!singular) {
        console.warn(
          '[qiankun] Setting singular as false may cause unexpected behavior while your browser not support window.Proxy',
        );
      }
    }
  }

  startSingleSpa({ urlRerouteOnly });

  frameworkStartedDefer.resolve();
}

/**
 * @author Kuitos
 * @since 2020-04-01
 */

import { importEntry } from 'import-html-entry';
import { concat, forEach, mergeWith } from 'lodash';
import { LifeCycles, ParcelConfigObject } from 'single-spa';
import getAddOns from './addons';
import { getMicroAppStateActions } from './globalState';
import { FrameworkConfiguration, FrameworkLifeCycles, HTMLContentRender, LifeCycleFn, LoadableApp } from './interfaces';
import { createSandboxContainer, css } from './sandbox';
import {
  Deferred,
  getContainer,
  getDefaultTplWrapper,
  getWrapperId,
  isEnableScopedCSS,
  performanceMark,
  performanceMeasure,
  toArray,
  validateExportLifecycle,
} from './utils';

function assertElementExist(element: Element | null | undefined, msg?: string) {
  // 如果contaienr element不存在，提示错误
  if (!element) {
    if (msg) {
      throw new Error(msg);
    }
    // 如果预先定义好的几种错误类型都不能存在，那么直接报element not existed
    throw new Error('[qiankun] element not existed!');
  }
}

function execHooksChain<T extends object>(
  hooks: Array<LifeCycleFn<T>>,
  app: LoadableApp<T>,
  global = window,
): Promise<any> {
  if (hooks.length) {
    return hooks.reduce((chain, hook) => chain.then(() => hook(app, global)), Promise.resolve());
  }

  return Promise.resolve();
}

async function validateSingularMode<T extends object>(
  validate: FrameworkConfiguration['singular'],
  app: LoadableApp<T>,
): Promise<boolean> {
  return typeof validate === 'function' ? validate(app) : !!validate;
}

// @ts-ignore
const supportShadowDOM = document.head.attachShadow || document.head.createShadowRoot;

function createElement(
  appContent: string,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  appName: string,
): HTMLElement {
  const containerElement = document.createElement('div');
  containerElement.innerHTML = appContent;
  const appElement = containerElement.firstChild as HTMLElement;
  if (strictStyleIsolation) {
    if (!supportShadowDOM) {
      console.warn(
        '[qiankun]: As current browser not support shadow dom, your strictStyleIsolation configuration will be ignored!',
      );
    } else {
      const { innerHTML } = appElement;
      appElement.innerHTML = '';
      let shadow: ShadowRoot;

      if (appElement.attachShadow) {
        shadow = appElement.attachShadow({ mode: 'open' });
      } else {
        // createShadowRoot was proposed in initial spec, which has then been deprecated
        shadow = (appElement as any).createShadowRoot();
      }
      shadow.innerHTML = innerHTML;
    }
  }

  if (scopedCSS) {
    const attr = appElement.getAttribute(css.QiankunCSSRewriteAttr);
    if (!attr) {
      appElement.setAttribute(css.QiankunCSSRewriteAttr, appName);
    }

    const styleNodes = appElement.querySelectorAll('style') || [];
    forEach(styleNodes, (stylesheetElement: HTMLStyleElement) => {
      css.process(appElement!, stylesheetElement, appName);
    });
  }

  return appElement;
}

/**
 * 用来获取`<div id=__qiankun_microapp_wrapper_for_${appInstanceId}_ data-name={appName}` 的dom
 * appName: 微应用名称
 * appInstanceId: 微应用实例
 * useLegacyRender: 是否使用render函数
 * strictStyleIsolation: 是否开启了严格模式的样式隔离
 * scopedCSS: 是否开启了实验性的样式隔离
 * elementGetter: 获取dom
 */
function getAppWrapperGetter(
  appName: string,
  appInstanceId: string,
  useLegacyRender: boolean,
  strictStyleIsolation: boolean,
  scopedCSS: boolean,
  elementGetter: () => HTMLElement | null,
) {
  return () => {
    // 自定义的render函数不能和strictStyleIsolation，scopedCSS兼容
    if (useLegacyRender) {
      if (strictStyleIsolation) throw new Error('[qiankun]: strictStyleIsolation can not be used with legacy render!');
      if (scopedCSS) throw new Error('[qiankun]: experimentalStyleIsolation can not be used with legacy render!');

      const appWrapper = document.getElementById(getWrapperId(appInstanceId));
      assertElementExist(
        appWrapper,
        `[qiankun] Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`,
      );
      return appWrapper!;
    }

    const element = elementGetter();
    assertElementExist(
      element,
      `[qiankun] Wrapper element for ${appName} with instance ${appInstanceId} is not existed!`,
    );

    if (strictStyleIsolation) {
      return element!.shadowRoot!;
    }

    return element!;
  };
}

const rawAppendChild = HTMLElement.prototype.appendChild;
const rawRemoveChild = HTMLElement.prototype.removeChild;
type ElementRender = (
  props: { element: HTMLElement | null; loading: boolean; container?: string | HTMLElement },
  phase: 'loading' | 'mounting' | 'mounted' | 'unmounted',
) => any;

/**
 * Get the render function
 * If the legacy render function is provide, used as it, otherwise we will insert the app element to target container by qiankun
 * @param appName
 * @param appContent
 * @param legacyRender
 */
function getRender(appName: string, appContent: string, legacyRender?: HTMLContentRender) {
  // 返回一个render函数
  const render: ElementRender = ({ element, loading, container }, phase) => {
    
    if (legacyRender) {
      // 如果legacyRender，会提示以下警告
      // 自定义的render函数不推奖使用，你可以使用container将element插入
      if (process.env.NODE_ENV === 'development') {
        console.warn(
          '[qiankun] Custom rendering function is deprecated, you can use the container element setting instead!',
        );
      }

      return legacyRender({ loading, appContent: element ? appContent : '' });
    }

    const containerElement = getContainer(container!);

    // 卸载微应用程序后，container可能会被移除
    // 例如在React的componentWillUnmount声明周期函数中，微应用的unmount声明周期函数将会被执行，react组件也一样会被移除
    // 如果不是在unmout声明周期函数中，可能会出现以下几种错误
    if (phase !== 'unmounted') {
      const errorMsg = (() => {
        switch (phase) {
          // 微应用在loading或者mounting的过程中，挂载容器不存在
          case 'loading':
          case 'mounting':
            return `[qiankun] Target container with ${container} not existed while ${appName} ${phase}!`;
          // 微应用在mounted的过程中，挂载容器不存在
          case 'mounted':
            return `[qiankun] Target container with ${container} not existed after ${appName} ${phase}!`;
          // 微应用在rendering的过程中，挂载容器不存在
          default:
            return `[qiankun] Target container with ${container} not existed while ${appName} rendering!`;
        }
      })();
      assertElementExist(containerElement, errorMsg);
    }

    // containerElement: classCloud
    // element: appContent
    if (containerElement && !containerElement.contains(element)) {
      // clear the container
      while (containerElement!.firstChild) {
        rawRemoveChild.call(containerElement, containerElement!.firstChild);
      }

      // append the element to container if it exist
      if (element) {
        rawAppendChild.call(containerElement, element);
      }
    }

    return undefined;
  };

  return render;
}

// 获取暴露出来的生命周期函数
function getLifecyclesFromExports(
  scriptExports: LifeCycles<any>,
  appName: string,
  global: WindowProxy,
  globalLatestSetProp?: PropertyKey | null,
) {
  // 检验子应用暴露出来的生命周期函数是否正确
  if (validateExportLifecycle(scriptExports)) {
    return scriptExports;
  }

  // 回退到沙箱最新设置的属性，如果有的话
  if (globalLatestSetProp) {
    const lifecycles = (<any>global)[globalLatestSetProp];
    if (validateExportLifecycle(lifecycles)) {
      return lifecycles;
    }
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn(
      `[qiankun] lifecycle not found from ${appName} entry exports, fallback to get from window['${appName}']`,
    );
  }

  // 如果module exports没有找到的话，回退到以${appName}命名的全局变量
  const globalVariableExports = (global as any)[appName];

  if (validateExportLifecycle(globalVariableExports)) {
    return globalVariableExports;
  }

  throw new Error(`[qiankun] You need to export lifecycle functions in ${appName} entry`);
}

let prevAppUnmountedDeferred: Deferred<void>;

export type ParcelConfigObjectGetter = (remountContainer?: string | HTMLElement) => ParcelConfigObject;

export async function loadApp<T extends object>(
  app: LoadableApp<T>,
  configuration: FrameworkConfiguration = {},
  lifeCycles?: FrameworkLifeCycles<T>,
): Promise<ParcelConfigObjectGetter> {
  // 微应用的入口和名称
  const { entry, name: appName } = app;
  // 实例ID
  const appInstanceId = `${appName}_${+new Date()}_${Math.floor(Math.random() * 1000)}`;

  const markName = `[qiankun] App ${appInstanceId} Loading`;
  if (process.env.NODE_ENV === 'development') {
    performanceMark(markName);
  }

  const {
    singular = false,
    sandbox = true,
    excludeAssetFilter,
    ...importEntryOpts
  } = configuration;

  /**
   * 获取入口html的内容和JS脚本执行器
   * template是link替换为style之后的template
   * execScripts是让JS代码在指定上下文中执行
   * assetPublicPath是静态资源路径
   */
  const {
    template,
    execScripts,
    assetPublicPath
  } = await importEntry(entry, importEntryOpts);

  // 由于single-spa的限制，加载，初始化和卸载不能同时进行
  // 在单利模式下，需要等所有微应用完成卸载之后才能加载微应用
  if (await validateSingularMode(singular, app)) {
    await (prevAppUnmountedDeferred && prevAppUnmountedDeferred.promise);
  }

  // 用一个元素包裹微应用的html模板，appContent = `<div id=__qiankun_microapp_wrapper_for_${appInstanceId}_ data-name={appName}`
  const appContent = getDefaultTplWrapper(appInstanceId, appName)(template);

  // 严格的样式隔离
  const strictStyleIsolation = typeof sandbox === 'object' && !!sandbox.strictStyleIsolation;
  // 实验性的样式隔离不能和严格样式不能同时开启
  const scopedCSS = isEnableScopedCSS(sandbox);

  // 将appContent转换为html dom元素，如果开启了样式隔离，则将appContent子元素即微应用入口模板用一个shadow dom包裹起来
  let initialAppWrapperElement: HTMLElement | null = createElement(
    appContent,
    strictStyleIsolation,
    scopedCSS,
    appName,
  );

  // 主应用装载微应用的节点
  const initialContainer = 'container' in app ? app.container : undefined;
  // 自定义render函数，这个是1.x版本遗留下来的问题，新版本会使用container，弃用render
  // 而且legacyRender与 strictStyleIsolation、scoped css 不兼容
  const legacyRender = 'render' in app ? app.render : undefined;

  const render = getRender(appName, appContent, legacyRender);

  // 第一次加载设置应用可见区域 dom 结构
  // 确保每次应用加载前容器 dom 结构已经设置完毕
  render({
    element: initialAppWrapperElement,
    loading: true,
    container: initialContainer
  }, 'loading');

  // 
  const initialAppWrapperGetter = getAppWrapperGetter(
    appName,
    appInstanceId,
    !!legacyRender,
    strictStyleIsolation,
    scopedCSS,
    () => initialAppWrapperElement,
  );

  // JS运行时沙箱
  // 保证每一个微应用都运行在一个干净的环境中
  let global = window;
  let mountSandbox = () => Promise.resolve();
  let unmountSandbox = () => Promise.resolve();
  const useLooseSandbox = typeof sandbox === 'object' && !!sandbox.loose;
  let sandboxContainer;
  // 如果开启了沙箱模式，那么将会创建一个运行时沙箱，这个沙箱其实由两部分组成，JS沙箱和样式沙箱
  // 该沙箱返回window代理对象和mount、unmout两个方法
  // unmout会让微应用失活，恢复被增强的方法，生成一堆rebuild函数，这些函数在微应用卸载的时候被调用，比如缓存
  // mount会激活微应用，执行一些petch方法，恢复原生的增强方法，将微应用恢复到卸载时的状态，当然微应用从初始化到挂载这一阶段就没有恢复一说了
  if (sandbox) {
    sandboxContainer = createSandboxContainer(
      appName,
      initialAppWrapperGetter,
      scopedCSS,
      useLooseSandbox,
      excludeAssetFilter,
    );
    // 用沙箱的代理对象作为接下来使用的全局对象
    global = sandboxContainer.instance.proxy as typeof window;
    mountSandbox = sandboxContainer.mount;
    unmountSandbox = sandboxContainer.unmount;
  }

  // 合并用户传入的一些生命周期函数和single-spa内置的生命周期函数
  const {
    beforeUnmount = [],
    afterUnmount = [],
    afterMount = [],
    beforeMount = [],
    beforeLoad = []
  } = mergeWith(
    {},
    getAddOns(global, assetPublicPath),
    lifeCycles,
    (v1, v2) => concat(v1 ?? [], v2 ?? []),
  );

  await execHooksChain(toArray(beforeLoad), app, global);

  // 获取暴露出来的生命中后期函数
  const scriptExports: any = await execScripts(global, !useLooseSandbox);
  
  const {
    bootstrap,
    mount,
    unmount,
    update
  } = getLifecyclesFromExports(
    scriptExports,
    appName,
    global,
    sandboxContainer?.instance?.latestSetProp,
  );

  // 给微应用注册通信方法并返回通信方法，然后将通信方法通过props注入到微应用
  const {
    onGlobalStateChange,
    setGlobalState,
    offGlobalStateChange,
  }: Record<string, Function> = getMicroAppStateActions(appInstanceId);

  // FIXME temporary way
  const syncAppWrapperElement2Sandbox = (element: HTMLElement | null) => (initialAppWrapperElement = element);

  const parcelConfigGetter: ParcelConfigObjectGetter = (remountContainer = initialContainer) => {
    let appWrapperElement: HTMLElement | null = initialAppWrapperElement;
    const appWrapperGetter = getAppWrapperGetter(
      appName,
      appInstanceId,
      !!legacyRender,
      strictStyleIsolation,
      scopedCSS,
      () => appWrapperElement,
    );
    
    // 挂载阶段需要执行的一系列方法：bootstrap, mount, unmount
    const parcelConfig: ParcelConfigObject = {
      name: appInstanceId,
      bootstrap,
      mount: [
        async () => {
          // 性能度量
          if (process.env.NODE_ENV === 'development') {
            const marks = performance.getEntriesByName(markName, 'mark');
            // mark length is zero means the app is remounting
            if (!marks.length) {
              performanceMark(markName);
            }
          }
        },
        // 单利模式需要等到上一个微应用卸载完成之后才可以执行挂载操作
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            return prevAppUnmountedDeferred.promise;
          }

          return undefined;
        },
        // 添加 mount hook, 确保每次应用加载前容器 dom 结构已经设置完毕
        async () => {
          const useNewContainer = remountContainer !== initialContainer;
          if (useNewContainer || !appWrapperElement) {
            // unmount阶段会被销毁，这里需要重新生成
            appWrapperElement = createElement(appContent, strictStyleIsolation, scopedCSS, appName);
            syncAppWrapperElement2Sandbox(appWrapperElement);
          }

          render({
            element: appWrapperElement,
            loading: true,
            container: remountContainer
          }, 'mounting');
        },
        mountSandbox,
        // exec the chain after rendering to keep the behavior with beforeLoad
        async () => execHooksChain(toArray(beforeMount), app, global),
        // 向微应用的mount函数传递参数
        async (props) => mount({
          ...props, container: appWrapperGetter(),
          setGlobalState,
          onGlobalStateChange
        }),
        // 完成挂载
        async () => render({
          element: appWrapperElement,
          loading: false,
          container: remountContainer
        }, 'mounted'),
        async () => execHooksChain(toArray(afterMount), app, global),
        // initialize the unmount defer after app mounted and resolve the defer after it unmounted
        async () => {
          if (await validateSingularMode(singular, app)) {
            prevAppUnmountedDeferred = new Deferred<void>();
          }
        },
        async () => {
          if (process.env.NODE_ENV === 'development') {
            const measureName = `[qiankun] App ${appInstanceId} Loading Consuming`;
            performanceMeasure(measureName, markName);
          }
        },
      ],
      unmount: [
        async () => execHooksChain(toArray(beforeUnmount), app, global),
        async (props) => unmount({ ...props, container: appWrapperGetter() }),
        unmountSandbox,
        async () => execHooksChain(toArray(afterUnmount), app, global),
        async () => {
          render({ element: null, loading: false, container: remountContainer }, 'unmounted');
          offGlobalStateChange(appInstanceId);
          // for gc
          appWrapperElement = null;
          syncAppWrapperElement2Sandbox(appWrapperElement);
        },
        async () => {
          if ((await validateSingularMode(singular, app)) && prevAppUnmountedDeferred) {
            prevAppUnmountedDeferred.resolve();
          }
        },
      ],
    };

    if (typeof update === 'function') {
      parcelConfig.update = update;
    }

    return parcelConfig;
  };

  return parcelConfigGetter;
}

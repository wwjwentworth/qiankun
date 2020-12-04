/**
 * @author Kuitos
 * @since 2020-02-21
 */

export { addErrorHandler, removeErrorHandler } from 'single-spa';

// 监听了error和unhandledrejection事件
export function addGlobalUncaughtErrorHandler(errorHandler: OnErrorEventHandlerNonNull): void {
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', errorHandler);
}

// 移除了error和unhandledrejection事件
export function removeGlobalUncaughtErrorHandler(errorHandler: (...args: any[]) => any) {
  window.removeEventListener('error', errorHandler);
  window.removeEventListener('unhandledrejection', errorHandler);
}

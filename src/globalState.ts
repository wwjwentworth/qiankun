/**
 * @author dbkillerf6
 * @since 2020-04-10
 */

import { cloneDeep } from 'lodash';
import { OnGlobalStateChangeCallback, MicroAppStateActions } from './interfaces';

let globalState: Record<string, any> = {};


const deps: Record<string, OnGlobalStateChangeCallback> = {};

// 触发全局监听，执行所有微应用注册的回调函数
function emitGlobal(state: Record<string, any>, prevState: Record<string, any>) {
  Object.keys(deps).forEach((id: string) => {
    if (deps[id] instanceof Function) {
      deps[id](cloneDeep(state), cloneDeep(prevState));
    }
  });
}

export function initGlobalState(state: Record<string, any> = {}) {
  // 如果当前状态等于上一次记录的globalState，那么表示状态没有发生改变
  if (state === globalState) {
    console.warn('[qiankun] state has not changed！');
  } else {
    // 将globalState深拷贝给prevGlobalState
    const prevGlobalState = cloneDeep(globalState);
    // 将当前状态深拷贝给globalState
    globalState = cloneDeep(state);
    // 触发全局监听
    emitGlobal(globalState, prevGlobalState);
  }
  return getMicroAppStateActions(`global-${+new Date()}`, true);
}

export function getMicroAppStateActions(id: string, isMaster?: boolean): MicroAppStateActions {
  return {
    /**
     * onGlobalStateChange 全局依赖监听
     *
     * 收集 setState 时所需要触发的依赖
     *
     * 限制条件：每个子应用只有一个激活状态的全局监听，新监听覆盖旧监听，若只是监听部分属性，请使用 onGlobalStateChange
     *
     * 这么设计是为了减少全局监听滥用导致的内存爆炸
     *
     * 依赖数据结构为：
     * {
     *   {id}: callback
     * }
     *
     * @param callback
     * @param fireImmediately
     */
    onGlobalStateChange(callback: OnGlobalStateChangeCallback, fireImmediately?: boolean) {
      // 参数callback必须是函数
      if (!(callback instanceof Function)) {
        console.error('[qiankun] callback must be function!');
        return;
      }
      // 如果监听已经存在的话，新的监听会覆盖旧的监听
      if (deps[id]) {
        console.warn(`[qiankun] '${id}' global listener already exists before this, new listener will overwrite it.`);
      }
      // 覆盖监听
      deps[id] = callback;
      const cloneState = cloneDeep(globalState);
      // 如果需要立即执行的话，那么会立即执行callback回调函数
      if (fireImmediately) {
        callback(cloneState, cloneState);
      }
    },

    /**
     * setGlobalState 更新 store 数据
     *
     * 1. 对输入 state 的第一层属性做校验，只有初始化时声明过的第一层（bucket）属性才会被更改
     * 2. 修改 store 并触发全局监听
     *
     * @param state
     */
    setGlobalState(state: Record<string, any> = {}) {
      // 状态没有发生改变的话，程序不继续
      if (state === globalState) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }

      const changeKeys: string[] = [];
      // 旧的全局状态
      const prevGlobalState = cloneDeep(globalState);

      globalState = cloneDeep(
        // 循环遍历新状态中的所有key
        Object.keys(state).reduce((_globalState, changeKey) => {
          // 如果是主应用或者是旧的全局状态中的key，才会执行更新操作；
          // 说明在主应用中可以新增属性，子应用只能更新属性
          if (isMaster || _globalState.hasOwnProperty(changeKey)) {
            // 记录被修改的key
            changeKeys.push(changeKey);
            // 更新旧的全局状态中的 { key: value }
            return Object.assign(_globalState, { [changeKey]: state[changeKey] });
          }
          console.warn(`[qiankun] '${changeKey}' not declared when init state！`);
          return _globalState;
        }, globalState),
      );
      if (changeKeys.length === 0) {
        console.warn('[qiankun] state has not changed！');
        return false;
      }
      emitGlobal(globalState, prevGlobalState);
      return true;
    },

    // 注销该应用下的依赖
    offGlobalStateChange() {
      delete deps[id];
      return true;
    },
  };
}

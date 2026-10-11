import * as React from 'react';

/**
 * 输入防抖。用于搜索框等高频输入场景 —— `useDeferredValue` 只降低渲染
 * 优先级，并不会减少请求次数，真正的防抖必须延迟值本身。
 */
export function useDebouncedValue<T>(value: T, delayMs = 350): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
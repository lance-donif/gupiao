import * as React from 'react';

/**
 * 桌面断点。必须与 styles.css 中 `@media (min-width: 1100px)` 的值保持一致，
 * 改这里一处即可（此前 TSX 与 CSS 各写一遍 1100，且 React 只在挂载时求值一次，
 * 用户缩放窗口不会重算）。
 */
const DESKTOP_BREAKPOINT_PX = 1100;

/** 响应式媒体查询，随窗口尺寸实时更新，卸载时自动清理监听。 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** 是否处于桌面三栏布局。 */
export function useIsDesktop(): boolean {
  return useMediaQuery(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
}
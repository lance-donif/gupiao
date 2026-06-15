/**
 * Prisma 客户端工具：用于在弱类型注入（`prisma: any`）场景下安全探测委托方法是否存在。
 * 用于兼容 stub client、测试 mock 等无法保证完整 Prisma 客户端类型的情况。
 */
export const hasPrismaDelegateMethod = (
  prisma: unknown,
  delegateName: string,
  methodName: string,
): boolean => {
  if (typeof prisma !== 'object' || prisma === null) {
    return false;
  }
  const delegate = (prisma as Record<string, unknown>)[delegateName];
  if (typeof delegate !== 'object' || delegate === null) {
    return false;
  }
  return typeof (delegate as Record<string, unknown>)[methodName] === 'function';
};

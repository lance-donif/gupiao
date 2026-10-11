import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Tailwind 类名合并：后写的类覆盖先写的同类属性。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
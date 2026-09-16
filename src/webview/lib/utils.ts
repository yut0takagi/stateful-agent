import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn 標準のクラス結合ヘルパ。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

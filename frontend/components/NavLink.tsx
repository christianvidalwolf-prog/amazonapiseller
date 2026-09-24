"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavLinkProps = {
  href: string;
  className: string;
  activeClassName: string;
  children: React.ReactNode;
};

export function NavLink({ href, className, activeClassName, children }: NavLinkProps) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link href={href} aria-current={isActive ? "page" : undefined} className={`${className} ${isActive ? activeClassName : ""}`}>
      {children}
    </Link>
  );
}

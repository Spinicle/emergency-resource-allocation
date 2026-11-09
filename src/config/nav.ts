import {
  ArrowRightLeft,
  Building2,
  ChartColumn,
  ClipboardList,
  FileText,
  LayoutDashboard,
  type LucideIcon,
  MapPin,
  Package,
  Siren,
  Users,
  Warehouse,
} from "lucide-react";
import type { Role } from "@/lib/enums";

// Sidebar entries and who sees them (docs/HANDOFF.md 4.7). Add your page here
// with the roles that may open it: the proxy sends other roles from the page
// (and pages under it) to /dashboard, and its API handlers enforce the same
// roles with requireRole. ADMIN is listed explicitly wherever it's allowed.

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  roles: readonly Role[];
};

export type NavGroup = { label: string; items: NavItem[] };

const ALL: readonly Role[] = ["ADMIN", "COORDINATOR", "FIELD_OFFICER", "CENTER_MANAGER"];
const FIELD: readonly Role[] = ["ADMIN", "COORDINATOR", "FIELD_OFFICER"];

export const NAV: NavGroup[] = [
  {
    label: "Operations",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL },
      { href: "/allocate", label: "Allocate", icon: ArrowRightLeft, roles: ["ADMIN", "COORDINATOR"] },
      { href: "/emergencies", label: "Emergencies", icon: Siren, roles: FIELD },
      { href: "/requests", label: "Requests", icon: ClipboardList, roles: FIELD },
      { href: "/reports", label: "Field reports", icon: FileText, roles: FIELD },
    ],
  },
  {
    label: "Stock",
    items: [
      // ADMIN too: three seeded centers have no manager. A CM stays on their own center; ADMIN picks one.
      { href: "/inventory", label: "Inventory", icon: Warehouse, roles: ["ADMIN", "CENTER_MANAGER"] },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/analytics", label: "Analytics", icon: ChartColumn, roles: ["ADMIN", "COORDINATOR"] },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/admin/users", label: "Users", icon: Users, roles: ["ADMIN"] },
      { href: "/admin/resources", label: "Resources", icon: Package, roles: ["ADMIN"] },
      { href: "/admin/centers", label: "Centers", icon: Building2, roles: ["ADMIN"] },
      { href: "/admin/locations", label: "Locations", icon: MapPin, roles: ["ADMIN"] },
    ],
  },
];

/** The nav as one role sees it; groups with nothing for the role are dropped. */
export function navFor(role: Role): NavGroup[] {
  return NAV.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter(
    (g) => g.items.length > 0,
  );
}

const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/** The nav item a page belongs to: its own path or one under it (/requests/12 → Requests). */
export function sectionFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => isActivePath(pathname, i.href));
}

/** True when pathname is the link's page or one under it (/requests/12 → /requests). */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: "Admin",
  COORDINATOR: "Coordinator",
  FIELD_OFFICER: "Field officer",
  CENTER_MANAGER: "Center manager",
};

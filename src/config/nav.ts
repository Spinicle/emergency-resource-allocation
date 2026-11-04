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
  /** The task that builds the page; shown on its placeholder until then. */
  owner: string;
  /** One line for the placeholder. */
  summary: string;
};

export type NavGroup = { label: string; items: NavItem[] };

const ALL: readonly Role[] = ["ADMIN", "COORDINATOR", "FIELD_OFFICER", "CENTER_MANAGER"];
const FIELD: readonly Role[] = ["ADMIN", "COORDINATOR", "FIELD_OFFICER"];

export const NAV: NavGroup[] = [
  {
    label: "Operations",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ALL, owner: "P2.4",
        summary: "KPIs, the impact map and recent activity, scoped to your role." },
      { href: "/allocate", label: "Allocate", icon: ArrowRightLeft, roles: ["ADMIN", "COORDINATOR"], owner: "P1.8",
        summary: "The priority queue and batch suggestions for allocating stock." },
      { href: "/emergencies", label: "Emergencies", icon: Siren, roles: FIELD, owner: "P2.1",
        summary: "Emergencies, their impacted locations and observations." },
      { href: "/requests", label: "Requests", icon: ClipboardList, roles: FIELD, owner: "P2.2",
        summary: "Resource requests and their items, allocations and status." },
      { href: "/reports", label: "Field reports", icon: FileText, roles: FIELD, owner: "P2.3",
        summary: "Field reports from MongoDB, with text and near-a-location search." },
    ],
  },
  {
    label: "Stock",
    items: [
      { href: "/inventory", label: "Inventory", icon: Warehouse, roles: ["CENTER_MANAGER"], owner: "P2.6",
        summary: "Your center's batches, adjustments, ledger and dispatches." },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/analytics", label: "Analytics", icon: ChartColumn, roles: ["ADMIN", "COORDINATOR"], owner: "P2.5",
        summary: "Unmet demand, fulfilment rates, escalating impacts and the field-vs-request gap." },
    ],
  },
  {
    label: "Admin",
    items: [
      { href: "/admin/users", label: "Users", icon: Users, roles: ["ADMIN"], owner: "P2.6",
        summary: "Create users, change roles and centers, deactivate accounts." },
      { href: "/admin/resources", label: "Resources", icon: Package, roles: ["ADMIN"], owner: "P2.6",
        summary: "The resource catalogue." },
      { href: "/admin/centers", label: "Centers", icon: Building2, roles: ["ADMIN"], owner: "P2.6",
        summary: "Resource centers and their status." },
      { href: "/admin/locations", label: "Locations", icon: MapPin, roles: ["ADMIN"], owner: "P2.6",
        summary: "Grid locations used by impacts and centers." },
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

/** The nav item for exactly this path, if it is one. */
export function findNavItem(path: string): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.href === path);
}

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

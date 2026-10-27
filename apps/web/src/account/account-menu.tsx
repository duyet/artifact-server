import {IconFiles, IconHelp, IconLayoutDashboard, IconLogout} from "@tabler/icons-react";
import {toast} from "sonner";

import {api, ApiError, type Session} from "@/api/client";
import {Avatar, AvatarFallback} from "@/components/ui/avatar";
import {Button} from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {principalInitials} from "@/review/principal-name";

/** The signed-in reader's own name and email, as the session reports them. */
export type Account = Session["account"];

interface AccountMenuProps {
  readonly account: Account;
  /** Where Sign out lands once the server has revoked the session. */
  readonly afterSignOut: string;
  /** The operator's Help page, or null when there is none or the context has not answered. */
  readonly helpUrl: string | null;
}

async function signOut(afterSignOut: string): Promise<void> {
  try {
    await api.logout();
  } catch (failed) {
    // A 401 means the session had already ended, so the reader is signed out.
    if (!(failed instanceof ApiError && failed.status === 401)) {
      toast.error("Sign out failed. You are still signed in.");
      return;
    }
  }
  window.location.assign(afterSignOut);
}

/**
 * The account menu's entries, for the avatar's own menu or another menu that
 * holds them on a narrow screen.
 */
export function AccountMenuItems({account, afterSignOut, helpUrl}: AccountMenuProps) {
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="truncate text-sm text-foreground">{account.displayName}</span>
          {account.email === null ? null : <span className="truncate font-normal">{account.email}</span>}
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem render={<a href="/?mine=1" />}>
          <IconFiles />
          My artifacts
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href="/review" />}>
          <IconLayoutDashboard />
          Console
        </DropdownMenuItem>
        {helpUrl === null ? null : (
          <DropdownMenuItem render={<a href={helpUrl} rel="noreferrer" target="_blank" />}>
            <IconHelp />
            Help
          </DropdownMenuItem>
        )}
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => void signOut(afterSignOut)}>
          <IconLogout />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}

/** The signed-in reader's avatar, with their initials, and its menu. */
export function AccountMenu({
  size = "default",
  ...props
}: AccountMenuProps & {readonly size?: "default" | "sm"}) {
  const name = props.account.displayName;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Account: ${name}`}
            className="rounded-full"
            size={size === "sm" ? "icon-sm" : "icon"}
            variant="ghost"
          />
        }
      >
        <Avatar size={size}>
          <AvatarFallback>{principalInitials({displayName: name, principalId: ""})}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <AccountMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

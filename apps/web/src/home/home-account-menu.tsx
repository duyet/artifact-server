import {IconFiles, IconHelp, IconLayoutDashboard, IconLogout} from "@tabler/icons-react";
import {useEffect, useState} from "react";

import {api, type Session} from "@/api/client";
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

/**
 * The signed-in reader's avatar and menu. This module loads only for a
 * signed-in reader, so an anonymous one never downloads the API client.
 */
export function AccountMenu({
  helpUrl,
  viewerName,
}: {
  readonly helpUrl: string | null;
  /** The tree's name for the reader, shown until the session answers. */
  readonly viewerName: string;
}) {
  const [account, setAccount] = useState<Session["account"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const session = await api.session();
        if (!cancelled) setAccount(session.account);
      } catch {
        // The menu keeps the tree's name and shows no email.
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);
  const name = account?.displayName ?? viewerName;
  const email = account?.email ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button aria-label={`Account: ${name}`} className="rounded-full" size="icon" variant="ghost" />}
      >
        <Avatar>
          <AvatarFallback>{principalInitials({displayName: name, principalId: ""})}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate text-sm text-foreground">{name}</span>
            {email === null ? null : <span className="truncate font-normal">{email}</span>}
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
            Workbench
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
          <DropdownMenuItem onClick={() => void api.logout().finally(() => window.location.assign("/"))}>
            <IconLogout />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

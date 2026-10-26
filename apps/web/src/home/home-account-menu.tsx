import {useEffect, useState} from "react";

import {api} from "@/api/client";
import {type Account, AccountMenu} from "@/account/account-menu";

/**
 * The signed-in reader's avatar and menu. This module loads only for a
 * signed-in reader, so an anonymous one never downloads the API client.
 */
export function HomeAccountMenu({
  helpUrl,
  viewerName,
}: {
  readonly helpUrl: string | null;
  /** The tree's name for the reader, shown until the session answers. */
  readonly viewerName: string;
}) {
  const [account, setAccount] = useState<Account | null>(null);
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
  return (
    <AccountMenu
      account={account ?? {displayName: viewerName, email: null}}
      afterSignOut="/"
      helpUrl={helpUrl}
    />
  );
}

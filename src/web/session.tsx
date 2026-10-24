import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { User } from './api.ts';

export type Person = Pick<User, 'id' | 'displayName'>;

export interface Session {
  /** chi ha effettuato l'accesso */
  user: User;
  /** utente di cui si vedono i dati (solo superadmin: può differire da user) */
  viewing: Person | null;
  /** utente effettivo i cui dati sono mostrati */
  subject: Person;
  tz: string;
  mailConfigured: boolean;
  setViewing: (u: Person | null) => void;
  refreshMe: () => Promise<void>;
  logout: () => Promise<void>;
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('Sessione non disponibile');
  return s;
}

// ---------- routing ad hash ----------

export function navigate(path: string) {
  location.hash = path;
}

export function parseHash(): { page: string; arg: string } {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, arg] = h.split('/');
  return { page: page || 'oggi', arg: arg ?? '' };
}

import { useAuth } from '../hooks/useAuth';
import type { AppView } from '../lib/types';

interface HeaderProps {
  onOpenGroups?: () => void;
  view?: AppView;
  onSetView?: (v: AppView) => void;
}

export default function Header({ onOpenGroups, view, onSetView }: HeaderProps) {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <div className="logo">⊞</div>
      <div>
        <h1>3-way Validator</h1>
        <p>ACS (ACS DB) &amp; Costsheet (Wisdom DB) vs PPS (File B)</p>
      </div>
      {user && (
        <div className="header-user">
          {onSetView && (
            <span style={{ display: 'inline-flex', gap: 4, marginRight: 4 }}>
              <button
                className={`btn btn-ghost${view === 'compare' ? ' active' : ''}`}
                onClick={() => onSetView('compare')}
                title="The validator / compare-data view"
              >
                Compare Data
              </button>
              <button
                className={`btn btn-ghost${view === 'summary' ? ' active' : ''}`}
                onClick={() => onSetView('summary')}
                title="Summary: Match / Diff / No Key by factory & season"
              >
                Summary
              </button>
              {user.perms?.can_manage && (
                <button
                  className={`btn btn-ghost${view === 'log' ? ' active' : ''}`}
                  onClick={() => onSetView('log')}
                  title="Admin log: who's online, logins, changes"
                >
                  Log
                </button>
              )}
            </span>
          )}
          {user.perms?.can_manage && onOpenGroups && (
            <button className="btn btn-ghost" onClick={onOpenGroups} title="Manage groups & permissions">
              Groups
            </button>
          )}
          <span className="header-username" title={user.email || user.username}>
            {user.display_name || user.username}
          </span>
          <button className="btn btn-ghost" onClick={() => logout()} title="Sign out">
            Logout
          </button>
        </div>
      )}
    </header>
  );
}

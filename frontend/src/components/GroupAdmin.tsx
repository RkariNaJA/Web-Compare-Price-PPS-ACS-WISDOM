/**
 * Admin screen for app-managed groups & permissions. Only reachable when the
 * signed-in user has can_manage (the "Groups" button in the header). Every
 * action calls the backend (which re-checks manage permission) and refreshes
 * from the returned full list, so the UI always mirrors the server. Styling
 * follows the app's washi/sumi design system (see .group-* in global.css).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  fetchGroups,
  removeGroupMember,
  setGroupPerms,
  type AppGroup,
} from '../lib/api';
import { useToast } from '../hooks/useToast';

export default function GroupAdmin({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // New-group form
  const [newName, setNewName] = useState('');
  const [newEdit, setNewEdit] = useState(true);
  const [newManage, setNewManage] = useState(false);

  // Per-group "add member" text, keyed by group name
  const [memberInput, setMemberInput] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetchGroups()
      .then(setGroups)
      .catch((err) => toast((err as Error).message, 'err'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => load(), [load]);

  const run = (p: Promise<AppGroup[]>, ok?: string): Promise<boolean> =>
    p
      .then((g) => {
        setGroups(g);
        if (ok) toast(ok, 'ok');
        return true;
      })
      .catch((err) => {
        toast((err as Error).message, 'err');
        return false;
      });

  const onCreate = () => {
    const name = newName.trim();
    if (!name) return;
    run(createGroup(name, newEdit, newManage), `Created "${name}"`).then((ok) => {
      if (!ok) return;
      setNewName('');
      setNewEdit(true);
      setNewManage(false);
    });
  };

  const onAddMember = (group: string) => {
    const username = (memberInput[group] || '').trim();
    if (!username) return;
    run(addGroupMember(group, username), `Added ${username} to ${group}`).then((ok) => {
      if (ok) setMemberInput((prev) => ({ ...prev, [group]: '' }));
    });
  };

  return (
    <div className="group-admin">
      <div className="group-inner">
        <div className="group-head">
          <h2>Groups &amp; Permissions</h2>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
            ← Back to validator
          </button>
        </div>

        {/* Create group */}
        <section className="group-card">
          <div className="group-card-title">Create a group</div>
          <div className="group-form">
            <input
              className="filter-select"
              placeholder="New group name (e.g. MER)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onCreate()}
            />
            <label className="group-check">
              <input type="checkbox" checked={newEdit} onChange={(e) => setNewEdit(e.target.checked)} />
              can edit
            </label>
            <label className="group-check">
              <input
                type="checkbox"
                checked={newManage}
                onChange={(e) => setNewManage(e.target.checked)}
              />
              can manage
            </label>
            <button className="btn btn-primary" onClick={onCreate} disabled={!newName.trim()}>
              + Create group
            </button>
          </div>
        </section>

        {/* Existing groups */}
        {loading ? (
          <p className="group-muted">Loading…</p>
        ) : groups.length === 0 ? (
          <section className="group-card">
            <p className="group-muted">No groups yet. Create one above — then add AD usernames to it.</p>
          </section>
        ) : (
          groups.map((g) => (
            <section className="group-card" key={g.name}>
              <div className="group-row">
                <span className="group-name">{g.name}</span>
                <label className="group-check">
                  <input
                    type="checkbox"
                    checked={g.can_edit}
                    onChange={(e) => run(setGroupPerms(g.name, e.target.checked, g.can_manage))}
                  />
                  can edit
                </label>
                <label className="group-check">
                  <input
                    type="checkbox"
                    checked={g.can_manage}
                    onChange={(e) => run(setGroupPerms(g.name, g.can_edit, e.target.checked))}
                  />
                  can manage
                </label>
                <button
                  className="btn btn-ghost"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    if (confirm(`Delete group "${g.name}"? This removes its members too.`))
                      run(deleteGroup(g.name), `Deleted "${g.name}"`);
                  }}
                >
                  Delete group
                </button>
              </div>

              {/* Members */}
              <div className="group-members">
                {g.members.length === 0 ? (
                  <span className="group-muted">No members yet.</span>
                ) : (
                  g.members.map((m) => (
                    <span key={m} className="group-chip">
                      {m}
                      <button onClick={() => run(removeGroupMember(g.name, m))} title={`Remove ${m}`}>
                        ×
                      </button>
                    </span>
                  ))
                )}
              </div>

              <div className="group-addmember">
                <input
                  className="filter-select"
                  placeholder="AD username (sAMAccountName)"
                  value={memberInput[g.name] || ''}
                  onChange={(e) => setMemberInput((prev) => ({ ...prev, [g.name]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && onAddMember(g.name)}
                />
                <button className="btn btn-ghost" onClick={() => onAddMember(g.name)}>
                  + Add member
                </button>
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

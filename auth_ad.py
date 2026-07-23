"""
Active Directory (LDAP) + local-dev authentication for the validator backend.

Framework-agnostic: every function returns plain dicts / booleans so sql_backend.py
can wrap them in a Flask session. The AD helpers are ported from the team's Django
`ActiveDirectoryBackend` (same env-var contract); the Django/ORM parts are dropped.

Auth precedence in `authenticate()`:
  1. Local dev account  — only if LOCAL_AUTH_ENABLED and the creds match .env
  2. Active Directory   — only if AD_ENABLED

All config comes from environment (loaded from DashBoard/.env by sql_backend.py).
`ldap3` is imported lazily inside functions so importing this module never requires
the AD stack to be present (handy for local-only dev).
"""
import logging
import os
import ssl

logger = logging.getLogger(__name__)


def env_bool(name, default=False):
    """Read an environment variable as a boolean (true/1/yes/on = True)."""
    return os.getenv(name, str(default)).strip().lower() in {"1", "true", "yes", "on"}


def clean_username(username):
    """Return the bare AD account name from DOMAIN\\user or user@domain."""
    value = (username or "").strip()
    if "\\" in value:
        value = value.rsplit("\\", 1)[1]
    if "@" in value:
        value = value.split("@", 1)[0]
    return value


# ── Active Directory ─────────────────────────────────────────────────────────
def create_ad_server():
    """Build the ldap3 Server object for AD from the AD_* env settings (host, port, TLS)."""
    from ldap3 import NONE, Server, Tls

    use_ssl = env_bool("AD_USE_SSL", False)
    validate = ssl.CERT_REQUIRED if env_bool("AD_TLS_VALIDATE", True) else ssl.CERT_NONE
    tls = Tls(validate=validate, ca_certs_file=os.getenv("AD_CA_CERT_FILE") or None)
    return Server(
        os.environ["AD_SERVER"],
        port=int(os.getenv("AD_PORT", "636" if use_ssl else "389")),
        use_ssl=use_ssl,
        tls=tls,
        connect_timeout=int(os.getenv("AD_CONNECT_TIMEOUT", "8")),
        # Some AD servers reject anonymous RootDSE/schema reads before bind.
        get_info=NONE,
    )


def bind_ad_user(username, password):
    """Open an ldap3 Connection that binds to AD as the given user (SIMPLE `user@domain`
    or NTLM `DOMAIN\\user`) — the successful bind IS the password check."""
    from ldap3 import AUTO_BIND_TLS_BEFORE_BIND, Connection, NTLM, SIMPLE

    domain = os.environ["AD_DOMAIN"]
    auth_mode = os.getenv("AD_AUTH_MODE", "SIMPLE").upper()
    if "\\" in username or "@" in username:
        bind_name = username
    elif auth_mode == "SIMPLE":
        bind_name = os.getenv("AD_USER_DN_TEMPLATE", "{username}@{domain}").format(
            username=username, domain=domain
        )
    else:
        bind_name = f"{domain}\\{username}"
    return Connection(
        create_ad_server(),
        user=bind_name,
        password=password,
        authentication=NTLM if auth_mode == "NTLM" else SIMPLE,
        auto_bind=AUTO_BIND_TLS_BEFORE_BIND if env_bool("AD_START_TLS", False) else True,
        receive_timeout=int(os.getenv("AD_RECEIVE_TIMEOUT", "10")),
        raise_exceptions=True,
    )


def read_ad_profile(connection, username):
    """After a successful bind, look the user up (AD_USER_FILTER) and return their profile
    (name, email) plus their memberOf groups — or None if not found."""
    from ldap3 import SUBTREE
    from ldap3.utils.conv import escape_filter_chars

    account = clean_username(username)
    search_filter = os.getenv(
        "AD_USER_FILTER", "(&(objectClass=user)(sAMAccountName={username}))"
    ).format(username=escape_filter_chars(account))
    found = connection.search(
        search_base=os.environ["AD_BASE_DN"],
        search_filter=search_filter,
        search_scope=SUBTREE,
        attributes=["sAMAccountName", "givenName", "sn", "displayName", "mail", "memberOf"],
        size_limit=2,
    )
    if not found or len(connection.entries) != 1:
        return None
    entry = connection.entries[0]
    value = lambda name: str(entry[name].value or "") if name in entry else ""
    groups = entry["memberOf"].values if "memberOf" in entry else []
    return {
        "username": value("sAMAccountName") or account,
        "first_name": value("givenName"),
        "last_name": value("sn"),
        "email": value("mail"),
        "display_name": value("displayName") or account,
        "groups": [str(group) for group in groups],
        "source": "ad",
    }


def is_group_allowed(groups):
    """True if AD_ALLOWED_GROUPS is empty (allow all) or intersects the user's groups.
    Allowed values may be plain CNs or full group DNs; user groups are full DNs."""
    allowed = [x.strip().casefold() for x in os.getenv("AD_ALLOWED_GROUPS", "").split(",") if x.strip()]
    if not allowed:
        return True
    actual = set()
    for group_dn in groups:
        folded = group_dn.casefold()
        actual.add(folded)
        if folded.startswith("cn="):
            actual.add(folded.split(",", 1)[0][3:])  # bare CN
    return bool(set(allowed) & actual)


# ── Local dev account ────────────────────────────────────────────────────────
def check_local_auth(username, password):
    """Return a profile dict if the creds match the .env dev account, else None."""
    if not env_bool("LOCAL_AUTH_ENABLED", False):
        return None
    want_user = os.getenv("LOCAL_AUTH_USER", "")
    want_pass = os.getenv("LOCAL_AUTH_PASSWORD", "")
    if not want_user:
        return None
    if (username or "").strip().casefold() != want_user.casefold() or password != want_pass:
        return None
    group = os.getenv("LOCAL_AUTH_GROUP", "").strip()
    return {
        "username": want_user,
        "first_name": "",
        "last_name": "",
        "email": "",
        "display_name": want_user,
        "groups": [group] if group else [],
        "source": "local",
    }


# ── Public entry point ───────────────────────────────────────────────────────
def authenticate(username, password):
    """Return a profile dict on success, or None. Never raises; logs the reason.

    Tries the local dev account first (so it works offline), then AD. Applies the
    AD_ALLOWED_GROUPS policy to whichever path succeeds."""
    if not username or not password:
        return None

    # 1) Local dev account
    local = check_local_auth(username, password)
    if local is not None:
        if not is_group_allowed(local["groups"]):
            logger.warning("Local login denied for %s: group policy", clean_username(username))
            return None
        return local

    # 2) Active Directory
    if not env_bool("AD_ENABLED", False):
        return None
    connection = None
    try:
        connection = bind_ad_user(username, password)
        profile = read_ad_profile(connection, username)
        if not profile:
            logger.warning("AD login for %s: bound but no directory profile", clean_username(username))
            return None
        if not is_group_allowed(profile["groups"]):
            logger.warning("AD login denied for %s: group policy", clean_username(username))
            return None
        return profile
    except Exception as exc:  # ldap3 raises on bad creds / TLS / timeout
        logger.warning("AD authentication failed for %s: %s", clean_username(username), type(exc).__name__)
        return None
    finally:
        if connection is not None:
            try:
                connection.unbind()
            except Exception:
                pass

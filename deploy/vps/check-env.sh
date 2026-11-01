#!/bin/sh
# Lists the settings in deploy/.env that still hold an example value, by name,
# never printing a value: the output can be pasted into a chat or a ticket.
#
#   sh deploy/vps/check-env.sh                 # reads deploy/.env
#   sh deploy/vps/check-env.sh path/to/.env    # or another file
#
# What it looks for is what production refuses to start on (`exampleValueProblems`
# in packages/core/src/environment.ts, used by the API, the worker and the
# bootstrap and migrate steps), plus the template's other placeholders:
#
#   - a password, key, token, secret or address containing "change-me";
#   - an address on a .example or .local host (the template's
#     your-domain.example lines);
#   - a database password shorter than 16 characters, on its own line or
#     inside a DATABASE_URL* address;
#   - any value naming your-domain.example or your-github-owner (the contact
#     address, the repositories), which production does not check but which
#     is never right on a real machine.
#
# Lines that start with "#" are ignored: a commented-out setting is not set.
# Prints one line per setting to change and exits 1, or says the file is clean
# and exits 0. Plain sh, so it runs on the machine without anything installed.
set -u

ENV_FILE="${1:-deploy/.env}"
MIN_PASSWORD=16

if [ ! -r "$ENV_FILE" ]; then
  echo "Cannot read $ENV_FILE. Run this from /opt/integr8, or give the file's path." >&2
  exit 2
fi

found=0

say() {
  if [ "$found" -eq 0 ]; then
    echo "Settings in $ENV_FILE still holding an example value:"
  fi
  echo "  $1: $2"
  found=1
}

# The host of scheme://[user[:password]@]host[:port]/..., lower-cased, or
# nothing for a value that is not an address.
host_of() {
  printf '%s\n' "$1" |
    sed -n 's#^[A-Za-z][A-Za-z0-9+.-]*://\([^@/?\#]*@\)\{0,1\}\([^:/?\#]*\).*#\2#p' |
    tr '[:upper:]' '[:lower:]'
}

# The password inside postgres://user:password@host/db, or nothing.
password_of() {
  printf '%s\n' "$1" | sed -n 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:@/?\#]*:\([^@/?\#]*\)@.*#\1#p'
}

is_example_host() {
  case "$1" in
    example | local | *.example | *.local | example. | local. | *.example. | *.local.) return 0 ;;
    *) return 1 ;;
  esac
}

# Read line by line rather than sourcing: the file holds JSON that a shell
# would mangle, and sourcing would run whatever is in it.
while IFS= read -r line || [ -n "$line" ]; do
  # Windows line endings, if the file was edited on a laptop.
  line=$(printf '%s' "$line" | tr -d '\r')
  case "$line" in
    '' | '#'*) continue ;;
    *=*) ;;
    *) continue ;;
  esac
  name=${line%%=*}
  value=${line#*=}
  # Surrounding quotes, as compose reads them.
  case "$value" in
    \"*\")
      value=${value#\"}
      value=${value%\"}
      ;;
    \'*\')
      value=${value#\'}
      value=${value%\'}
      ;;
  esac
  [ -n "$value" ] || continue

  lower=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  secret=0
  address=0
  case "$name" in *PASSWORD* | *SECRET* | *TOKEN* | *KEY*) secret=1 ;; esac
  case "$name" in *URL* | *ORIGINS* | *ISSUER* | *DSN*) address=1 ;; esac

  if [ $((secret + address)) -gt 0 ]; then
    case "$lower" in
      *change-me*)
        say "$name" 'still the example value (change-me)'
        continue
        ;;
    esac
  fi

  if [ "$address" -eq 1 ]; then
    flagged=0
    old_ifs=$IFS
    IFS=,
    for entry in $value; do
      host=$(host_of "$entry")
      if [ -n "$host" ] && is_example_host "$host"; then
        flagged=1
      fi
    done
    IFS=$old_ifs
    if [ "$flagged" -eq 1 ]; then
      say "$name" 'an example address (.example or .local host)'
      continue
    fi
  fi

  case "$lower" in
    *your-domain.example* | *your-github-owner*)
      say "$name" "still the template's placeholder (your-domain.example or your-github-owner)"
      continue
      ;;
  esac

  case "$name" in
    POSTGRES_PASSWORD | INTEGR8_APP_PASSWORD | INTEGR8_AUTH_PASSWORD | INTEGR8_PLATFORM_PASSWORD | SUPABASE_AUTH_DB_PASSWORD)
      if [ "${#value}" -lt "$MIN_PASSWORD" ]; then
        say "$name" "shorter than $MIN_PASSWORD characters"
      fi
      ;;
    DATABASE_URL | DATABASE_URL_ADMIN | DATABASE_URL_AUTH | DATABASE_URL_PLATFORM)
      password=$(password_of "$value")
      if [ -n "$password" ] && [ "${#password}" -lt "$MIN_PASSWORD" ]; then
        say "$name" "its password is shorter than $MIN_PASSWORD characters"
      fi
      ;;
  esac
done <"$ENV_FILE"

if [ "$found" -eq 1 ]; then
  echo "Change the settings above in $ENV_FILE (values are not shown), then run this again."
  exit 1
fi
echo "$ENV_FILE: no example values left."
exit 0

#!/bin/sh

# Chromium creates its session-bus connection before Tavern's JavaScript runs. A compositor or
# terminal restarted inside the same login session can therefore leave AppImages with a stale
# DBUS_SESSION_BUS_ADDRESS (commonly /tmp/dbus-*), making the Wayland ScreenCast portal unreachable.
# Some launch environments instead set the known-invalid sentinel "disabled:", which Chromium
# rejects before it can contact the portal. Repair missing, stale, or known-invalid addresses;
# abstract, autolaunch, TCP, and live custom sockets are valid session layouts and must be left alone.
session_bus_address_needs_repair() {
  address=$1
  [ -n "$address" ] || return 0
  [ "$address" = "disabled:" ] && return 0

  old_ifs=$IFS
  IFS=';'
  for endpoint in $address; do
    case "$endpoint" in
      unix:path=*)
        socket_path=${endpoint#unix:path=}
        socket_path=${socket_path%%,*}
        if [ -S "$socket_path" ]; then
          IFS=$old_ifs
          return 1
        fi
        ;;
      *)
        # This launcher cannot safely validate non-filesystem transports. Preserve them.
        IFS=$old_ifs
        return 1
        ;;
    esac
  done
  IFS=$old_ifs
  return 0
}

runtime_dir=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}
runtime_bus="$runtime_dir/bus"
runtime_owner=$(stat -c %u "$runtime_dir" 2>/dev/null || stat -f %u "$runtime_dir" 2>/dev/null || true)

if session_bus_address_needs_repair "${DBUS_SESSION_BUS_ADDRESS:-}"; then
  if [ -S "$runtime_bus" ] && [ "$runtime_owner" = "$(id -u)" ]; then
    DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime_bus"
    export DBUS_SESSION_BUS_ADDRESS
  else
    # A known-dead address blocks D-Bus's standard platform lookup. With no canonical runtime bus,
    # remove only that invalid hint and let the client library locate the active session normally.
    unset DBUS_SESSION_BUS_ADDRESS
  fi
fi

launcher_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$launcher_dir/tavern-bin" "$@"

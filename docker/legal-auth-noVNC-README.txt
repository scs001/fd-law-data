legal-auth-broker noVNC
=======================

The noVNC listener is pod-local. Never create a public Service or Ingress for
port 6080. Access it from an operator machine with one of the supported private
channels:

  kubectl -n scraw port-forward pod/<legal-auth-pod> 6080:6080
  # then open http://127.0.0.1:6080/vnc.html

or through the fleet's Tailscale/internal authenticated ingress.

Set LEGAL_AUTH_VNC_PASSWORD from a Secret in production. A profile directory
is private to one (source, account_id) and must not be reused by another
identity.

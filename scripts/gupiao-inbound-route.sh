#!/bin/sh
set -eu
# Match the host's existing Mihomo connection mark without changing its rules.
iptables -t mangle -C PREROUTING -i ens3 -p tcp --dport 10000 -m conntrack --ctstate NEW -j MARK --set-mark 0x1 2>/dev/null || iptables -t mangle -A PREROUTING -i ens3 -p tcp --dport 10000 -m conntrack --ctstate NEW -j MARK --set-mark 0x1
iptables -t mangle -C PREROUTING -i ens3 -p tcp --dport 10000 -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x1 2>/dev/null || iptables -t mangle -A PREROUTING -i ens3 -p tcp --dport 10000 -m conntrack --ctstate NEW -j CONNMARK --set-mark 0x1

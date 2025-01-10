#!/bin/sh

# TODO check root / check parameter / check user exists / API key

URL=$1
PORT=22

systemctl stop home-tunnel

groupadd home-tunnel
useradd -m -g home-tunnel home-tunnel

cp -v home-tunnel /home/home-tunnel/
chown home-tunnel:home-tunnel /home/home-tunnel/home-tunnel
sed -e "s|{{URL}}|$URL|g" -e "s/{{PORT}}/$PORT/g" home-tunnel.service.template > /etc/systemd/system/home-tunnel.service

systemctl daemon-reload
systemctl start home-tunnel
systemctl enable home-tunnel

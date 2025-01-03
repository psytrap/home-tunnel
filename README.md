# Home Tunnel

Simple port tunneling using Deno Deploy as a free serverless hosting for the relay station.

Three components:
* Local client running on the host system
* Relay server hosted on Deno Deploy relaying data between local client and remote client
* Remote client running on the remotly machine accessing the forwarded port on the local host system

No security, very prone to DoS attacks. Using a second SSH tunnel is recommend for security.

# Example

## Setup Relay Server

* Create a Playground server on Deno Deploy
* Copy and paste the home-tunnel-relay.ts code into the playground and press run

# Setup Local Client

* Download binaries for your host system architecture
* Run from terminal
```
home-tunnel --relay <URL for your relay server> --port <e.g. 22 to forward SSH>
 ```
* For persistance install it as a system service
```
sudo install_service.sh <URL for your relay server>
```
* Check status of service with (exit by pressing 'q')
```
systemctl status home-tunnel.service
```

# Run Remote Client

* Download binaries for your remote machine architecture
* Run from terminal and mirror port
```
home-tunnel --relay <URL for your relay server> --port <e.g. 22222>
```
* In another terminal use SSH
```
ssh -p 22222 <user on local system>@127.0.0.1
```

# Alternatives

* Cloudflare Tunnel
* ngrok
* localtunnel
* frp
* bore
* tunnelto
* rathole

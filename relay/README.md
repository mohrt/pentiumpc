# Network relay for the Pentium PC

This folder runs the Pentium PC's network on your own computer, with Docker: a relay that gives the emulated PC its
network and internet access ([websockproxy](https://github.com/benjamincburns/websockproxy)), and
[WebOne](https://github.com/atauenis/webone), a proxy that lets Windows 98's Internet Explorer open today's https sites.

```sh
docker compose up -d      # start them (the first time downloads and builds them)
docker compose down       # stop them
```

Then, on the [Pentium PC](https://mohrt.github.io/pentiumpc/), enter `ws://localhost:8086/` as the **Relay** in
**Machine setup...**.

**[NETWORKING.md](../NETWORKING.md)** has the full steps: setting up the network card in Windows, pointing Internet
Explorer at WebOne (`172.31.98.10`, port `8080`), and what to do when something doesn't work.

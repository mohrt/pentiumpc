# Networking

The Pentium PC can have a network card and go on the internet. Its browser, Internet Explorer, can even open today's
secure (https) web sites, with a little help.

A web page isn't allowed to open network connections of its own, so the PC can't reach the internet by itself. Its
network card sends everything through a **relay**: a small server, outside the browser, that the page connects to over
a WebSocket. The relay hands the PC an address, answers its name lookups, and passes its traffic on to the internet and
back.

**No relay comes with the web page. You need to run one yourself, or use the address of an existing one you trust.**
The relay sees everything the PC sends, so don't use one you don't trust.

## The ready-made relay, for Docker

The easiest way is the [`relay/`](relay/) folder, which runs two containers on your own computer with Docker (for
example [Docker Desktop](https://www.docker.com/products/docker-desktop/)):

- **The relay:** [websockproxy](https://github.com/benjamincburns/websockproxy), the relay of the v86 emulator. It
  gives the PC an address on its own network (10.5.x.x, by DHCP) and internet access through your computer.
- **WebOne:** [WebOne](https://github.com/atauenis/webone), a proxy for old browsers. Internet Explorer 5 can't open
  today's https sites: their encryption is too new for it. WebOne opens the sites for it, with today's encryption, and
  hands them on as plain web pages it can read.

To start them:

1. Install Docker and start it.
2. Get this project's files (`git clone https://github.com/mohrt/pentiumpc.git`, or download it as a zip from GitHub).
3. In a terminal, in the project's `relay` folder, run:

   ```sh
   docker compose up -d
   ```

   The first time, this downloads the relay and builds WebOne's container, which takes a minute or two. They keep
   running, and start again with Docker, until you stop them with `docker compose down`.

The relay only accepts connections from your own computer (`localhost`), and the PC can reach the internet and WebOne,
but not your local network or your computer itself.

## Connecting the PC

1. On the page, open **Machine setup...**, enter `ws://localhost:8086/` as the **Relay**, and choose **Start the PC**.
   The status line under the screen says *network connected* once the page reaches the relay.
2. The PC now has a network card: an NE2000 compatible, at I/O port 300h and interrupt (IRQ) 9. Put the Windows 98 CD
   image in the CD-ROM drive (drop the `.iso` on the page), since Windows copies the network software from it.
3. In Windows 98, open **Control Panel > Add New Hardware** and choose **Next** twice. When it lists devices, choose
   **No, the device isn't in the list**, then **Yes (Recommended)** to let Windows search. It finds the
   **NE2000 Compatible** card. (If the search seems stuck, give it a few minutes; if you restart the PC part way, Windows
   picks up the card when it next starts.)
4. Windows asks for the card's settings: set **Interrupt (IRQ)** to **9** (it suggests 3), leave the I/O address at
   300-31F, and choose **OK**. It copies the files from the CD and asks to restart; choose **Yes**.
5. TCP/IP is set to get its address automatically, which is what the relay expects. To check it worked, choose
   **Start > Run**, type `winipcfg` and choose the **Novell 2000 Adapter**: its IP address starts `10.5.` and its
   gateway is `10.5.0.1`.

Windows 95 finds the card the same way (Control Panel > Add New Hardware), with the same interrupt.

## Browsing the web

Set Internet Explorer to use WebOne as its proxy, with the Internet Connection Wizard (Internet Explorer starts it the
first time, or choose **Start > Run** and type `icwconn1`; if MSN's sign-up starts instead, cancel it and run
`icwconn1`):

1. Choose **I want to set up my Internet connection manually, or I want to connect through a local area network
   (LAN)**, then **I connect through a local area network (LAN)**.
2. Untick **Automatic discovery of proxy server**, tick **Manual Proxy Server**, and choose **Next**.
3. For **HTTP**, enter `172.31.98.10` and the port `8080`. Choose **Next** twice, **No** to setting up a mail account,
   and **Finish**.

(Later, the same settings are in Internet Explorer's **Tools > Internet Options > Connections > LAN Settings**.)

Now type addresses as usual, such as `68k.news`: WebOne opens the site for Internet Explorer, with today's encryption
when the site needs it. Most of today's sites are too modern for a browser of 1999: their pages may come out blank or
broken (Wikipedia's does). Sites made for old computers work well, such as [68k.news](http://68k.news/) (the news)
and [FrogFind](http://frogfind.com/) (search), and so does the [Wayback Machine](http://web.archive.org/), which shows
sites as they were in 1999. When an old address no longer exists, WebOne offers the Wayback Machine's copy. WebOne's
own page, `http://172.31.98.10:8080/`, has its settings and tools.

Other programs work through the relay too, without WebOne, as long as what they connect to still speaks their old
protocols: FTP, telnet, IRC, and old games' internet play. Programs that need today's encryption (such as email from
Gmail) can't connect.

## Your own relay elsewhere

Any relay for the v86 emulator works: one Ethernet frame per binary WebSocket message, each way. The page is served over
https, so browsers only let it connect to a `wss://` relay, or a `ws://` one on your own computer (`localhost`). To
serve a relay to other computers, put it behind a web server that adds TLS; websockproxy's README explains how, and how
to limit its use. A relay open to everyone can be used for abuse in your name, so keep it to people you trust.

## Questions

- **The status line says *network relay not reachable*.** Check the containers are running (`docker compose ps` in the
  `relay` folder) and that the relay address is `ws://localhost:8086/`.
- **Windows didn't find the card.** The card is only fitted while a relay is set; set it in machine setup and start the
  PC again. You can also add it by hand: in Add New Hardware choose **No, I want to select the hardware from a list**,
  then **Network adapters**, **Novell/Anthem** and **NE2000 Compatible**, with I/O 300h and IRQ 9.
- **The card has a yellow mark in Device Manager.** Its interrupt is probably wrong: in its **Resources** tab, set the
  interrupt to 9.
- **DOS and Windows 3.1:** use an NE2000 packet driver (`NE2000 0x60 9 0x300`) with a DOS TCP/IP program such as mTCP,
  or Windows 3.1 with Trumpet Winsock.
- **Why not a PCI card?** Without ACPI, Windows 98 finds PCI devices through the BIOS's Plug and Play support, which
  this PC's BIOS (SeaBIOS) doesn't provide, so it can't see PCI cards. The NE2000 on the older ISA bus needs no help
  from the BIOS, and every system of the time has a driver for it.

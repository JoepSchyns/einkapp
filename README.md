# EinkApp

This repository contains the code for an e-ink painting displayed in our living room. The painting is a [Visionect Place & Play](https://www.visionect.com/) that wirelessly cycles through art from various sources every half hour.

To make it feel like a real museum piece, I added an information card next to the painting just like you would find in a gallery. This card is a small secondary e-ink display (Crowpanel 2.13) that shows the title, description, and a QR code linking to the source of the currently displayed artwork. Communication with the Crowpanel uses the [OpenDisplay](https://opendisplay.org/) protocol. Since the OpenDisplay firmware did not support the Crowpanel out of the box, I added support for it. A contribution I hope to eventually get merged upstream.

Art is fetched from a variety of sources (Reddit, Unsplash, Art Institute of Chicago, Rijksmuseum, and more), each implemented as a separate module. The architecture is designed to make adding new sources as simple and straightforward as possible.

The system supports multiple displays by assigning a session to each one. Sessions can be managed through the admin interface, and a session ID can be used to retrieve information about the currently displayed content. There are two ways to access this information: visiting the info webpage in a browser (which updates automatically via Server-Sent Events when content changes), or pairing a secondary e-ink display like the Crowpanel, which receives updates over BLE whenever content changes. Since OpenDisplay communicates by sending images, a screenshot service is used to render the info webpage before transmitting it to the display.

## Architecture

```mermaid

graph TD
Browser1["Browser\n Admin"] --> |"HTTPS"| Proxy
Browser3["Browser\n Info Display"] --> |"HTTPS"| Proxy
    subgraph nat[NAT]
        Proxy["Reverse Proxy\n Caddy"] --> |"HTTP"| Frontend
        Browser2["Browser\n Visionect Display Management"] --> |"HTTP"| VisionectServer
        Eink["E-Ink Main Display\n Visionect Place & Play 13 "] <--> VisionectServer
        

        subgraph dockernet[Docker Network]
            VisionectServer["Visionect Server\n visionect-server-v3"] --> |"HTTP\n GET /image"| Frontend
            Frontend["Frontend\nAstro / nginx"]
            API["API\nHono / Node.js"]
            Screenshot["screenshot-service\nPlaywright / Node.js"] --> |"HTTP\n GET /info?id=…" | Frontend
            BLE["ble-service\nFastAPI / Python"]
            DB[("SQLite")]
        end

        Frontend -->|"/api/*"| API
        API --- DB
        API -->|"GET /screenshot?url=…"| Screenshot
        API -->|"GET /scan\n PUT /image"| BLE
        BLE -->|"BLE\n OpenDisplay"| Display["E-Ink Info Display\n Crowpanel 2.13"]
    end

    style nat fill:#666
    style dockernet fill:#888
```

## Screenshots

<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <img src="https://placehold.co/480x300" alt="Living room setup" width="320" /><br/>
        <sub><em>Living room - main display & info card</em></sub>
      </td>
      <td align="center" width="50%">
        <img src="docs/infocard.jpg" alt="Info display" width="320" /><br/>
        <sub><em>Info page - title, description & QR code</em></sub>
      </td>
    </tr>
    <tr >
      <td align="center">
        <img src="docs/session.jpg" alt="Admin - session overview" width="320" /><br/>
        <sub><em>Admin - session overview</em></sub>
      </td>
    </tr>
  </table>
</div>


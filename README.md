# Global Registry

Self-hosted infrastructure inventory and IP address management for Cloudflare Workers and D1. Manage devices, virtual machines, networks, and IP addresses through a web UI or REST API, with Cloudflare Access authentication and an audit log.

## Features

- Devices, virtual machines, and interfaces organized by location.
- VLANs, IPv4/IPv6 prefixes, address reservations, and automatic IP allocation.
- Audit history with actors and before-and-after snapshots.
- REST API with OpenAPI documentation and an interactive explorer.
- English and Japanese UI.

## Deployment

### Quick deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alflag-org/global-registry)

For evaluation and temporary use. Creates an independent repository copy, Worker, D1 database, and Workers Builds connection. Upstream updates are your responsibility; GitHub **Sync fork** is unavailable.

### Long-term deployment

[Fork this repository](https://github.com/alflag-org/global-registry/fork) and connect the fork to Cloudflare Workers Builds. Use GitHub **Sync fork → Update branch** to receive upstream updates.

Both methods apply D1 migrations before publishing the Worker. Enable Worker-level Cloudflare Access after deployment; everyone admitted by Access can read and edit inventory.

See the [deployment guide](docs/deployment.md) for setup, updates, and API authentication.

## Contributing

See [Contributing](CONTRIBUTING.md) for local development, tests, and pull requests. Report vulnerabilities privately as described in [Security policy](SECURITY.md).

## License

[Apache License 2.0](LICENSE).

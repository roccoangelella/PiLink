import os from "node:os";
import { pmpNat, upnpNat, type Gateway } from "@achingbrain/nat-port-mapper";
import { gateway4sync } from "default-gateway";

export const DIRECT_HTTP_PORT = 8080;
export const DIRECT_HTTPS_PORT = 8443;

const MAPPING_TTL_MS = 60 * 60 * 1000;
const MAPPING_ATTEMPT_TIMEOUT_MS = 5_000;
const MAPPING_DESCRIPTION = "PiLink direct HTTPS";
const PUBLIC_IP_LOOKUP_TIMEOUT_MS = 8_000;
const PUBLIC_IP_SERVICES = ["https://api.ipify.org", "https://checkip.amazonaws.com"];

export interface ManagedPortMappings {
  publicIp: string;
  release(): Promise<void>;
}

export class DirectNetworkError extends Error {
  constructor(message: string, readonly canUseManualFallback: boolean) {
    super(message);
  }
}

export async function openAutomaticPortMappings(): Promise<ManagedPortMappings> {
  const route = gateway4sync();
  const localHost = localIpv4(route.int);
  const errors: string[] = [];

  try {
    const upnp = upnpNat({ ttl: MAPPING_TTL_MS, autoRefresh: true, description: MAPPING_DESCRIPTION });
    for await (const gateway of upnp.findGateways({ signal: AbortSignal.timeout(MAPPING_ATTEMPT_TIMEOUT_MS) })) {
      try {
        return await mapPorts(gateway, localHost, AbortSignal.timeout(MAPPING_ATTEMPT_TIMEOUT_MS));
      } catch (error) {
        if (error instanceof DirectNetworkError && !error.canUseManualFallback) throw error;
        errors.push(`UPnP gateway ${gateway.host}: ${errorMessage(error)}`);
      }
    }
    errors.push("No UPnP gateway responded");
  } catch (error) {
    if (error instanceof DirectNetworkError && !error.canUseManualFallback) throw error;
    errors.push(`UPnP discovery: ${errorMessage(error)}`);
  }

  try {
    return await mapPorts(pmpNat(route.gateway, { ttl: MAPPING_TTL_MS, autoRefresh: true, description: MAPPING_DESCRIPTION }), localHost, AbortSignal.timeout(MAPPING_ATTEMPT_TIMEOUT_MS));
  } catch (error) {
    if (error instanceof DirectNetworkError && !error.canUseManualFallback) throw error;
    errors.push(`NAT-PMP gateway ${route.gateway}: ${errorMessage(error)}`);
  }
  throw new DirectNetworkError(`PiLink could not create router port mappings. ${errors.join("; ")}`, true);
}

export async function discoverPublicIpv4(request: typeof fetch = fetch): Promise<string> {
  const errors: string[] = [];
  for (const service of PUBLIC_IP_SERVICES) {
    try {
      const response = await request(service, {
        headers: { accept: "text/plain" },
        signal: AbortSignal.timeout(PUBLIC_IP_LOOKUP_TIMEOUT_MS),
      });
      const publicIp = (await response.text()).trim();
      if (response.ok && isPublicIpv4(publicIp)) return publicIp;
      errors.push(`${service}: ${response.ok ? "response was not a public IPv4 address" : `HTTP ${response.status}`}`);
    } catch (error) {
      errors.push(`${service}: ${errorMessage(error)}`);
    }
  }
  throw new DirectNetworkError(`PiLink could not determine the public IPv4 address automatically. ${errors.join("; ")}`, true);
}

export async function mapPorts(gateway: Gateway, localHost: string, signal?: AbortSignal): Promise<ManagedPortMappings> {
  const abortOptions = signal ? { signal } : {};
  try {
    const httpMapping = await gateway.map(DIRECT_HTTP_PORT, localHost, {
      externalPort: 80,
      protocol: "TCP",
      ttl: MAPPING_TTL_MS,
      autoRefresh: true,
      description: MAPPING_DESCRIPTION,
      ...abortOptions,
    });
    if (httpMapping.externalPort !== 80) throw new DirectNetworkError(`The router assigned public TCP port ${httpMapping.externalPort} instead of 80.`, true);
    const httpsMapping = await gateway.map(DIRECT_HTTPS_PORT, localHost, {
      externalPort: 443,
      protocol: "TCP",
      ttl: MAPPING_TTL_MS,
      autoRefresh: true,
      description: MAPPING_DESCRIPTION,
      ...abortOptions,
    });
    if (httpsMapping.externalPort !== 443) throw new DirectNetworkError(`The router assigned public TCP port ${httpsMapping.externalPort} instead of 443.`, true);
    const publicIp = await gateway.externalIp(signal ? { signal } : undefined);
    if (!isPublicIpv4(publicIp)) {
      throw new DirectNetworkError(`The router reported '${publicIp}', which is not a public IPv4 address. Direct nip.io hosting cannot work behind CGNAT.`, false);
    }
    let released = false;
    return {
      publicIp,
      async release(): Promise<void> {
        if (released) return;
        released = true;
        await gateway.stop({ signal: AbortSignal.timeout(2_000) });
      },
    };
  } catch (error) {
    await gateway.stop({ signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    throw error;
  }
}

export function isPublicIpv4(value: string): boolean {
  const octets = value.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = octets;
  return first !== 0 && first !== 10 && first !== 127 && first < 224 && !(first === 100 && second >= 64 && second <= 127) && !(first === 169 && second === 254) && !(first === 172 && second >= 16 && second <= 31) && !(first === 192 && second === 168);
}

function localIpv4(interfaceName: string | null): string {
  const addresses = interfaceName ? os.networkInterfaces()[interfaceName] : undefined;
  const address = addresses?.find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
  if (!address) throw new DirectNetworkError("PiLink could not determine the LAN IPv4 address used by the default router.", true);
  return address;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

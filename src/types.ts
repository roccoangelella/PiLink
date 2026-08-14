export interface OAuthClient {
  client_id: string;
  client_secret_hash: string;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  token_endpoint_auth_method?: "client_secret_post" | "client_secret_basic" | "none";
  scope: string;
  created_at: string;
  disabled_at?: string;
  secret_rotated_at?: string;
  token_version?: number;
}

export interface AuthorizationCode {
  code: string;
  client_id: string;
  client_version: number;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
  expires_at: number;
}

export interface TokenPayload {
  sub: string;
  scope: string;
  iss: string;
  aud: string;
  jti: string;
  client_version?: number;
  iat?: number;
  exp?: number;
}

export interface ClientStore {
  clients: OAuthClient[];
}

export interface RefreshTokenRecord {
  token_hash: string;
  client_id: string;
  scope: string;
  created_at: string;
  expires_at: number;
  client_version?: number;
}

export interface RefreshTokenStore {
  tokens: RefreshTokenRecord[];
}

import { createHmac, timingSafeEqual } from "node:crypto";

type Claims = Readonly<{ v: 1; kid: string; aud: "steam-top-student"; origin: string; identityToken: string; iat: number; exp: number }>;
const canonical = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class StudentCredentialService {
  readonly #keys: Readonly<Record<string, Uint8Array>>; readonly #activeKeyId: string; readonly #origin: string; readonly #now: () => number; readonly #lifetimeMs: number;
  constructor(options: Readonly<{ keys: Readonly<Record<string, Uint8Array>>; activeKeyId: string; origin: string; now?: () => number; lifetimeMs?: number }>) {
    if (!options.keys[options.activeKeyId] || Object.values(options.keys).some((key) => key.byteLength < 32)) throw new TypeError("INVALID_STUDENT_CREDENTIAL_KEYS");
    const origin = new URL(options.origin); if (origin.origin !== options.origin) throw new TypeError("INVALID_STUDENT_ORIGIN");
    this.#keys=options.keys;this.#activeKeyId=options.activeKeyId;this.#origin=options.origin;this.#now=options.now??Date.now;this.#lifetimeMs=options.lifetimeMs??43_200_000;
  }
  issue(identityToken: string): string {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(identityToken)) throw new TypeError("INVALID_IDENTITY_TOKEN");
    const iat=Math.floor(this.#now()/1000),claims:Claims={v:1,kid:this.#activeKeyId,aud:"steam-top-student",origin:this.#origin,identityToken,iat,exp:iat+Math.floor(this.#lifetimeMs/1000)};
    const payload=canonical(claims),signature=createHmac("sha256",this.#keys[this.#activeKeyId]!).update(payload).digest("base64url");return `${payload}.${signature}`;
  }
  verify(value: string, origin: string): string | undefined {
    const [payload,signature,...extra]=value.split(".");if(!payload||!signature||extra.length||signature.length!==43)return undefined;
    let claims:Claims;try{const decoded:unknown=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));if(!decoded||typeof decoded!=="object"||Array.isArray(decoded))return undefined;claims=decoded as Claims;}catch{return undefined;}
    const key=this.#keys[claims.kid];if(!key)return undefined;const expected=createHmac("sha256",key).update(payload).digest("base64url");
    if(expected.length!==signature.length||!timingSafeEqual(Buffer.from(expected),Buffer.from(signature)))return undefined;
    const now=Math.floor(this.#now()/1000);return claims.v===1&&claims.aud==="steam-top-student"&&claims.origin===this.#origin&&origin===this.#origin&&Number.isSafeInteger(claims.iat)&&Number.isSafeInteger(claims.exp)&&claims.iat<=now+60&&claims.exp>now&&claims.exp-claims.iat<=43_200&&/^[A-Za-z0-9_-]{43}$/u.test(claims.identityToken)?claims.identityToken:undefined;
  }
}

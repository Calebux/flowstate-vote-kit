# Flowstate Vote Kit

Drop-in GoodBuilders / Flow Council voting for a **Next.js (App Router) + wagmi v2 + viem** app on Celo.
Users can claim their voting rights and vote for your project without leaving your site.

## The voting flow

1. **Read status.** The hook reads the council contract and GoodDollar identity on-chain: verified? voting power? current ballot?
2. **Claim voting rights.** The user signs Flowstate's standard claim message (free, no gas). Your `/api/flowstate` route checks the signature and forwards it to Flowstate's eligibility API.
3. **Review.** The hook builds the ballot, simulates it and estimates the CELO fee.
4. **Vote.** The user sends one `vote()` transaction to the council. **Only your project's allocation changes.** Votes the user gave other projects stay in place.
5. **Confirm.** The hook waits for the receipt and checks that the transaction really cast the reviewed vote. A pending hash is saved, so a reload never sends a second vote.

## Files

| Path | Put it at | What it is |
|---|---|---|
| `lib/flowstate.ts` | `src/lib/flowstate.ts` (or `lib/`) | Config, ABI, ballot rules. **Edit the CONFIGURE ME block.** |
| `app/api/flowstate/route.ts` | `app/api/flowstate/route.ts` | Server route: GET council details, POST claim relay. No secrets needed. |
| `hooks/useFlowVote.ts` | `src/hooks/useFlowVote.ts` | The React hook that runs the whole flow. |
| `examples/VotePanel.tsx` | anywhere | Minimal unstyled UI showing how to use the hook. |

The imports use the `@/` alias (`@/lib/flowstate`, `@/hooks/useFlowVote`), which is the Next.js default.
If your alias is different, adjust it.

## Setup

1. **Requirements:** `next` ≥ 14, `react` ≥ 18, `wagmi` 2.x, `@wagmi/core` 2.x, `viem` 2.x, with Celo (42220) in your wagmi config.
2. **Configure** the top of `lib/flowstate.ts`:
   - `PROJECT_RECIPIENT`: your project's recipient address in the council, **lowercase**. Look it up at
     `https://flowstate.network/api/flow-council/recipients?chainId=42220&councilId=0x889e0aadaa3f8b28a794ef70da147827c620a590`
   - `PROJECT_NAME`: your project name exactly as Flowstate lists it. The API route refuses to serve if the name doesn't match, which guards against a wrong address.
   - `FLOW_COUNCIL`: already set to GoodBuilders S5. Change it only for a different council.
3. Render `<VotePanel />` (or your own UI built on `useFlowVote`) inside your `WagmiProvider`.

## Good to know

- Voters need a **GoodDollar-verified** wallet and a little **CELO** for gas.
- Voting rights belong to one wallet per GoodDollar identity. If a user claimed them with another wallet, they must vote with that one.
- **Smart/contract wallets** can't sign the claim this way. Send those users to Flowstate's own page (the example links to it).
- The route accepts only same-origin requests that carry the `x-flow-vote: 1` header.
- If the council's `maxVotingSpread` (the most projects one ballot may back) is already used up by the user's other votes, they'll be asked to edit their ballot on Flowstate first.

## License

MIT. See [LICENSE](LICENSE). Use it, copy it, change it.

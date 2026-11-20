"use client";

// Minimal, unstyled example. Render it inside your existing WagmiProvider once
// the user has connected a wallet on Celo. Style it however you like.
import { useAccount } from "wagmi";
import { type Address } from "viem";
import { useFlowVote } from "@/hooks/useFlowVote";
import { FLOW_URL, PROJECT_NAME, flowAllocation } from "@/lib/flowstate";

export default function VotePanel() {
  const { address } = useAccount();
  if (!address) return <p>Connect a wallet to vote for {PROJECT_NAME}.</p>;
  // key={address} resets all voting state when the user switches wallets.
  return <Ballot key={address} address={address} />;
}

function Ballot({ address }: { address: Address }) {
  const vote = useFlowVote(address);
  const s = vote.snapshot;
  const allocation = s ? flowAllocation(s) : null;

  return (
    <section>
      <h2>Vote for {PROJECT_NAME}</h2>
      {vote.busy && <p role="status">{vote.busy}</p>}
      {vote.error && <p role="alert">{vote.error}</p>}
      {vote.notice && <p role="status">{vote.notice}</p>}

      {!s ? null
        : !s.verified ? (
          <>
            <p>Verify your GoodDollar identity with this wallet first.</p>
            <a href="https://wallet.gooddollar.org" target="_blank" rel="noopener noreferrer">Verify on GoodDollar</a>
            <button disabled={!!vote.busy} onClick={vote.refresh}>I’ve verified · refresh</button>
          </>
        ) : !s.recipientActive ? (
          <p>{PROJECT_NAME} is not accepting votes in this council right now.</p>
        ) : s.votingPower === 0n ? (
          <button disabled={!!vote.busy} onClick={vote.claim}>Claim voting rights (signature, no fee)</button>
        ) : vote.review ? (
          <>
            <p>Change your {PROJECT_NAME} allocation from {String(allocation?.current ?? 0n)} to {vote.review.amount}. Other votes stay in place.</p>
            <p>Estimated network fee: ~{Number(vote.review.fee).toFixed(5)} CELO</p>
            <button disabled={!!vote.busy} onClick={vote.submit}>Confirm vote</button>
            <button disabled={!!vote.busy} onClick={vote.cancelReview}>Back</button>
          </>
        ) : (
          <>
            <label>
              Votes (max {String(allocation?.maximum ?? 0n)}):{" "}
              <input inputMode="numeric" value={vote.amount} onChange={e => vote.setAmount(e.target.value.replace(/\D/g, ""))} />
            </label>
            <button disabled={!!vote.busy || !vote.amount} onClick={vote.prepare}>Review vote</button>
          </>
        )}

      {(vote.pending || vote.confirmed) && (
        <p>
          <a href={`https://celoscan.io/tx/${(vote.confirmed ?? vote.pending)!.hash}`} target="_blank" rel="noopener noreferrer">View transaction ↗</a>
          {vote.pending && <button disabled={!!vote.busy} onClick={vote.checkPending}>Check submitted vote</button>}
        </p>
      )}

      <p><small>Using a smart/contract wallet? Vote directly on <a href={FLOW_URL} target="_blank" rel="noopener noreferrer">Flowstate</a>.</small></p>
    </section>
  );
}

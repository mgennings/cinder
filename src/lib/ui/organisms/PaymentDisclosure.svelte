<script lang="ts">
	// The complete account, one labeled tap after the next action. The material
	// cost and credit consequences remain above the payment button on /pro; this
	// is the longer explanation for somebody who wants to inspect the machinery.
	//
	// EVERY CLAUSE HERE IS LOAD-BEARING AND EVERY ONE OF THEM IS CHECKED AGAINST
	// CODE. The mapping lives in docs/pro-payments.md, clause by clause, with the
	// file and line that makes each true. If a change makes one of these
	// sentences false, the sentence is not the thing to edit.
	import Disclosure from '$lib/ui/atoms/Disclosure.svelte';
</script>

<section aria-labelledby="money-heading" class="mt-6 border-t border-line pt-3">
	<h2 id="money-heading" class="sr-only">Payment and privacy details</h2>
	<Disclosure summary="How do payment and privacy work?">
		<div class="rounded-lg border border-line bg-ink-raised px-4 py-5 sm:px-5">
			<h3 class="text-sm font-semibold text-body">what happens when you pay</h3>
			<ul class="mt-3 space-y-3 text-sm leading-relaxed text-mist">
				<li>
					cinder still never sees your file, its name, or your key. paying does not change that
					and it does not change how a transfer works. the encryption happens on your device
					before anything is sent, and it happens the same way whether you paid or not.
				</li>
				<li>
					stripe handles the payment. you type your card on stripe's own page, not on cinder's —
					we never render a card field and could not read one if we did. stripe sees your card
					and collects an email address for the receipt.
				</li>
				<li>
					cinder never asks stripe for your card or your email, never reads them, and never
					writes them down. what we keep is one line: this account has this many sends left,
					and the date it last bought some. there is no name, no address, and no card on our
					side to lose.
				</li>
				<li>
					a payment is never linked to a note. notes and file transfers carry no account at
					all, so there is nothing to link them to. stripe is told only a random one-time
					reference that we delete as soon as your purchase lands — after that, nothing
					anywhere connects a payment to you.
				</li>
				<li>
					a credit is spent when cinder gives your browser permission to send big, which
					happens before your file is encrypted or uploaded — not when the link appears, and
					not when the file arrives. that permission lasts about fifteen minutes and lives in
					the tab that asked for it, so anything else you start there costs nothing extra,
					while a reload or a second tab asks again and spends another. cancel before the link
					appears and the credit is still spent.
				</li>
				<li>
					if a delivery breaks partway, the pieces are destroyed and the credit is gone. cinder
					has no way to see which transfer failed, which is the same reason it can never see
					who you sent it to. credits do not expire and they never come back.
				</li>
			</ul>
			<p class="mt-4 text-xs leading-relaxed text-ghost">
				receipts and any refund of the purchase itself go through stripe, because they are
				the only ones who know who paid. a spent credit is not refundable by anyone,
				including us.
			</p>
			<p class="mt-3 text-xs leading-relaxed text-ghost">
				account data is minimized to run the account. it is never used for tracking, never
				sold, and never attached to notes or transfers.
			</p>
		</div>
	</Disclosure>
</section>

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
	title: "Privacy — LearnHarness",
	description: "What the hosted LearnHarness stores and why.",
};

const SOURCE_URL =
	process.env.NEXT_PUBLIC_SOURCE_URL ??
	"https://github.com/not-wowmagic/learnharness/tree/hosted-web";

export default function PrivacyPage() {
	return (
		<main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-5 px-6 py-12 font-ui text-sm leading-relaxed text-muted-foreground">
			<div>
				<h1 className="font-title text-3xl text-foreground">Privacy</h1>
				<p className="mt-2 text-xs text-muted-foreground/70">
					This is a modified, self-hosted version of LearnHarness. The source
					code is available under the AGPL-3.0 at{" "}
					<a className="underline underline-offset-2 hover:text-foreground" href={SOURCE_URL}>
						the repository
					</a>
					.
				</p>
			</div>

			<section className="flex flex-col gap-2">
				<h2 className="font-ui text-sm uppercase tracking-widest text-foreground">
					Your workspace
				</h2>
				<p>
					Your sessions, knowledge graph, settings, and uploaded notes are stored
					on this server in a directory tied to a random, signed <code>lh_ws</code>{" "}
					cookie. You do not need an account to use the app. Clearing the cookie
					makes that workspace inaccessible to you.
				</p>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-ui text-sm uppercase tracking-widest text-foreground">
					Optional account
				</h2>
				<p>
					If you choose “Save your progress”, Supabase Auth sends a magic link to
					the email you enter. Supabase stores the email and the mapping from your
					account to your workspace id. Your chats and knowledge graph stay on
					this server; only the email and workspace id are stored in Supabase.
				</p>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-ui text-sm uppercase tracking-widest text-foreground">
					Retention
				</h2>
				<p>
					Anonymous workspaces that have not been used for 30 days are deleted
					automatically. Account-owned workspaces are kept until you ask for
					them to be deleted.
				</p>
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="font-ui text-sm uppercase tracking-widest text-foreground">
					Third parties
				</h2>
				<p>
					Model requests go to the provider configured by the operator. Web
					research and dictation, when enabled, contact their configured
					services. This deployment does not run third-party analytics.
				</p>
			</section>

			<Link href="/" className="text-xs underline underline-offset-2 hover:text-foreground">
				← Back to LearnHarness
			</Link>
		</main>
	);
}

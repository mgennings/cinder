// The two numbers behind Cinder Pro, written once.
//
// They are the only figures in this repository that have to agree with
// something outside it — a Stripe Price object, and the CinderProCredits stack
// parameter the webhook credits with. docs/pro-payments.md is where that
// agreement is checked, clause by clause.
//
// The bundle is why the price is $4.94 rather than $0.94: Stripe takes 2.9% plus
// a fixed 30¢, and on a sub-dollar charge that fixed part is 92% of the fee. Ten
// sends in one charge takes the fee from about a third of the money to about a
// tenth.

export const PRO_PRICE = '$4.94';
export const PRO_CREDITS = 10;

/** "1 credit" / "3 credits". Nobody should be reading "1 credits". */
export const creditWord = (n: number) => (n === 1 ? '1 credit' : `${n} credits`);

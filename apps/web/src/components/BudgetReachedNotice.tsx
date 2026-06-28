/**
 * Shown when the global daily spend ceiling is hit (`daily_budget_reached`) —
 * i.e. Drafture has run out of funds for the day. Surfaced immediately in the
 * page where the result/Terraform would have appeared, so the visitor gets a
 * friendly explanation and a way to reach the operator instead of a dead end.
 *
 * Distinct from the per-visitor daily cap (`daily_cap_reached`), which just means
 * that one visitor used their allotment and others are unaffected.
 */

const LINKEDIN_URL = "https://www.linkedin.com/in/smatthiesen";

export function BudgetReachedNotice(): JSX.Element {
  return (
    <div className="banner banner--warn budget-out" role="alert">
      <p className="budget-out__text">
        <strong>I'm out of money for today — sorry!</strong> Drafture is a free,
        self-funded demo and it has hit its daily spend limit.{" "}
        <a href={LINKEDIN_URL} target="_blank" rel="noreferrer noopener">
          Message me on LinkedIn
        </a>{" "}
        and I'll top it up. Designs you've already opened still work, and full
        generation resumes tomorrow.
      </p>
    </div>
  );
}

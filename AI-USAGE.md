## Method

* **Workflow:** Strict Test-Driven Development (TDD). I used AI to generate the test suites based on the provided Golden Test Vector and edge cases first, ensuring the tests failed. Then, I prompted the AI to write the implementation to turn the tests green.
* **Prompting Strategy:** Targeted, single-file prompts. I deliberately withheld the full system context (like API rate limits) from the AI when generating the Math Engine to ensure strict boundary decoupling. 
* **Design Storage:** The system architecture and API constraints were kept in `DECISIONS.md` and my own head. The AI was treated strictly as a localized executor, not a system architect.

## Tools

* **Assistant/Tool:** VSCode Codex Extension
* **Model & Settings:** GPT-5.6 Terra (configured with High reasoning level)
* **Estimated Share of Code Produced:** ~70% (boilerplate, tests, and modular utility logic), with architectural design, mathematical validation, and manual overrides performed entirely by hand.
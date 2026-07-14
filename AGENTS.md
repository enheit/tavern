Be skeptial. Do not lie.

**Reporting a result**

You must only say that is something working by relying on the visual results, or results from unit tests.

Good responses:

- I created multiple unit tests, after runing them all tests are passed. Result is achived.
- I run Playright I manually checked the flow and eveyrthign work as expected
- I created e2e tests, I run them, all flows are working correct

Bad responses:

- I have internal knowledge, it seems to be working
- I hope it will work

**Keeping secrets**

Each time you create secret, or you have access to the secret that maybe were created by 3rd party tool that is shown only for this moment, than you have to copy the secret and put it into bitwarden mcp under the respective project folder.

**Behaviour**

Before asking a human to do something on their own, you must check if the gaol can be achived by:

- using exising MCP server or MCP server can be installed and used
- using exising CLI tool
- using browser by controlling the tab

**Veryfing a result and running tests**

- You MUST only run those tests that you think you could affect
- NEVER run all tests blidnly. All tests can be run only be CI/CD pipeline
- Do not run tests when you work. Run tests only after all features are implemented and ready

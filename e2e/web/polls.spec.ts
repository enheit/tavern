import { expect, test } from "../harness/fixtures";

test.describe("point polls", () => {
  test("two members bid, the creator resolves, and history records the payout", async ({
    api,
    twoContexts,
  }, testInfo) => {
    const { server, clients } = twoContexts;
    const [creator, predictor] = clients;
    await Promise.all([
      api.seedPoints(creator.user, server.id, 100),
      api.seedPoints(predictor.user, server.id, 100),
    ]);
    await expect(creator.page.getByTestId("points-balance")).toHaveText("100");
    await expect(predictor.page.getByTestId("points-balance")).toHaveText("100");

    await creator.page.getByTestId("composer-poll").click();
    await creator.page.getByTestId("poll-question").fill("Which team wins?");
    await creator.page.getByTestId("poll-outcome-0").fill("Blue");
    await creator.page.getByTestId("poll-outcome-1").fill("Red");
    await creator.page.getByTestId("poll-duration").selectOption("300");
    await creator.page.getByTestId("poll-create-submit").click();

    await expect(creator.page.getByTestId("poll-rail")).toContainText("Which team wins?");
    await expect(predictor.page.getByTestId("poll-rail")).toContainText("Which team wins?");

    await predictor.page.getByRole("button", { name: "Place bid" }).click();
    await predictor.page.getByRole("button", { name: "Red", exact: false }).click();
    await predictor.page.getByTestId("poll-bid-amount").fill("30");
    await predictor.page.getByTestId("poll-bid-submit").click();
    await expect(predictor.page.getByTestId("points-balance")).toHaveText("70");

    await creator.page.getByRole("button", { name: "Manage" }).click();
    await creator.page.getByRole("button", { name: "Blue", exact: false }).click();
    await creator.page.getByTestId("poll-bid-amount").fill("20");
    await creator.page.getByTestId("poll-bid-submit").click();
    await expect(creator.page.getByTestId("points-balance")).toHaveText("80");

    await creator.page.getByRole("button", { name: "Manage" }).click();
    await creator.page.getByRole("button", { name: "Close bidding now" }).click();
    await creator.page.getByRole("button", { name: "Manage" }).click();
    await creator.page.getByRole("button", { name: "Red", exact: false }).click();
    await creator.page.getByTestId("poll-resolve-submit").click();

    await expect(predictor.page.getByTestId("poll-rail")).toContainText("You won 20 points");
    await predictor.page
      .getByTestId("poll-rail")
      .screenshot({ path: testInfo.outputPath("poll-result-rail.png") });
    await predictor.page.getByTestId("points-trigger").click();
    await expect(predictor.page.getByTestId("points-pending-poll")).toHaveText("+50");
    await expect(creator.page.getByTestId("poll-rail")).toContainText("You lost 20 points");

    await predictor.page.getByTestId("workspace-tab-polls").click();
    const history = predictor.page.getByTestId("polls-tab");
    await expect(history).toContainText("Which team wins?");
    await history.getByText("Participants (2)").click();
    await expect(history).toContainText("payout 50");
    await expect(history).toContainText("payout 0");

    await predictor.page
      .getByTestId("polls-tab")
      .screenshot({ path: testInfo.outputPath("poll-history.png") });
  });
});

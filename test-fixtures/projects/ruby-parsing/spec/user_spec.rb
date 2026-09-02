# frozen_string_literal: true

RSpec.describe User do
  it "is excluded from the scan by the default exclusion regex" do
    expect(described_class).to be
  end
end

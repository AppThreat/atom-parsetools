# typed: strict
# frozen_string_literal: true

extend T::Sig

sig { params(name: String, times: Integer).returns(String) }
def greet(name, times)
  ([name] * times).join(", ")
end

sig { returns(T.nilable(Integer)) }
def maybe_count = nil

sig { void }
def log_it
  warn(<<~MESSAGE)
    nothing to report
  MESSAGE
end

def undeclared(value)
  value&.to_s
end

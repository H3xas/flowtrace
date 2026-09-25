using System;

namespace Greenhouse.Alerts.Identity
{
    public interface IGrowerSession
    {
        string GrowerId { get; }
    }

    public interface IGrowerIdentity
    {
        string RequireSignedInGrower();
    }

    public class GrowerIdentity : IGrowerIdentity
    {
        private readonly IGrowerSession _session;

        public GrowerIdentity(IGrowerSession session)
        {
            _session = session;
        }

        public string RequireSignedInGrower()
        {
            if (string.IsNullOrEmpty(_session.GrowerId))
            {
                throw new UnauthorizedAccessException("a signed-in grower is required");
            }

            return _session.GrowerId;
        }
    }
}

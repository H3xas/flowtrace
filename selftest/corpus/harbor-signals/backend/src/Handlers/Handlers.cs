using System.Threading.Tasks;
using Harbor.Signals.Services;

namespace Harbor.Signals.Handlers
{
    public class Cargo
    {
        public string Id { get; set; }
    }

    public interface IChangeHandler<T>
    {
        Task Handle(T change);
    }

    public abstract class AuditHandlerBase<T> : IChangeHandler<T>
    {
        public abstract Task Handle(T change);
    }

    public class CargoAuditHandler : AuditHandlerBase<Cargo>
    {
        private readonly IManifestLog _log;

        public CargoAuditHandler(IManifestLog log)
        {
            _log = log;
        }

        public override Task Handle(Cargo change)
        {
            return _log.Write(change.Id);
        }
    }

    public abstract class RelayTransformer
    {
        public abstract Task Transform(string payload);
    }

    public class SignalRelay : RelayTransformer
    {
        private readonly ISignalWire _wire;

        public SignalRelay(ISignalWire wire)
        {
            _wire = wire;
        }

        public override Task Transform(string payload)
        {
            return _wire.Forward(payload);
        }
    }
}

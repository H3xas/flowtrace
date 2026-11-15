using System.Collections.Generic;
using System.Linq;

namespace Quill.Works.Finishes
{
    public enum FinishKind { Matte, Gloss, Satin }

    public interface IFinisher
    {
        FinishKind Kind { get; }
        void Apply(string item);
    }

    public class MatteFinisher : IFinisher
    {
        public FinishKind Kind => FinishKind.Matte;
        public void Apply(string item) { }
    }

    public class GlossFinisher : IFinisher
    {
        public FinishKind Kind { get { return FinishKind.Gloss; } }
        public void Apply(string item) { }
    }

    public class TunedFinisher : IFinisher
    {
        private readonly FinishKind _kind;
        public TunedFinisher(FinishKind kind) { _kind = kind; }
        public FinishKind Kind => _kind;
        public void Apply(string item) { }
    }

    public class FinishRouter
    {
        private readonly Dictionary<FinishKind, IFinisher> _finishers;

        public FinishRouter(IEnumerable<IFinisher> finishers)
        {
            _finishers = finishers.ToDictionary(f => f.Kind);
        }

        public void Matte(string item)
        {
            _finishers[FinishKind.Matte].Apply(item);
        }

        public void ByKind(FinishKind kind, string item)
        {
            var finisher = _finishers[kind];
            finisher.Apply(item);
        }

        public void Maybe(FinishKind kind, string item)
        {
            if (_finishers.TryGetValue(kind, out IFinisher finisher))
            {
                finisher.Apply(item);
            }
        }
    }
}

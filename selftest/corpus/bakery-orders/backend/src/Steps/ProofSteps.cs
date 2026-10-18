using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Services;

namespace Bakery.Api.Steps
{
    public interface IProofStep
    {
        Task ProcessAsync(Dough dough);
    }

    public class ProofDoughStep : IProofStep
    {
        private const int MaxHours = 30;
        private readonly IOvenToggles _toggles;
        private readonly IStarterRepository _starters;

        public ProofDoughStep(IOvenToggles toggles, IStarterRepository starters)
        {
            _toggles = toggles;
            _starters = starters;
        }

        public Task ProcessAsync(Dough dough)
        {
            if (dough.Notes == null) return Task.CompletedTask;

            if (dough.Style == DoughStyle.Sourdough)
            {
                _starters.SaveStarter(dough);
            }

            if (_toggles.IsToggleEnabled("LongProof"))
            {
                dough.Hours += 2;
            }

            if (dough.Hours > MaxHours) throw new OverProofedException();

            if (dough.Starter < 1)
            {
                dough.Valid = false;
            }

            Shape(dough);
            return Task.CompletedTask;
        }

        private void Shape(Dough dough)
        {
            if (dough.Shape == LoafShape.Boule)
            {
                _starters.SaveShape(dough);
            }
        }
    }
}

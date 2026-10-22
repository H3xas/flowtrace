using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Pipelines;

namespace Bakery.Api.Services
{
    public interface IOvenToggles
    {
        bool IsToggleEnabled(string name);
    }

    public interface IStarterRepository
    {
        void SaveStarter(Dough dough);
        void SaveShape(Dough dough);
    }

    public class StarterRepository : IStarterRepository
    {
        public void SaveStarter(Dough dough)
        {
        }

        public void SaveShape(Dough dough)
        {
        }
    }

    public interface IProofService
    {
        Task<Dough> ProofAsync(DoughRequest request);
    }

    public class ProofService : IProofService
    {
        private readonly IProofPipeline _proofs;

        public ProofService(IProofPipeline proofs)
        {
            _proofs = proofs;
        }

        public async Task<Dough> ProofAsync(DoughRequest request)
        {
            var dough = new Dough(request);
            return await _proofs.ProcessAsync(dough);
        }
    }
}

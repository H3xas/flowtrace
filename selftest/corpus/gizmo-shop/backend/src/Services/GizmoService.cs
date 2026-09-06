using System.Threading.Tasks;

namespace GizmoShop.Api.Services
{
    public interface IGizmoService
    {
        Task<object> GetCatalog();
        Task<bool> Activate(string serialCode);
    }

    public interface IGizmoRepository
    {
        Task<object> ListAll();
        Task<bool> MarkActivated(string serialCode);
    }

    public class GizmoRepository : IGizmoRepository
    {
        public Task<object> ListAll() => Task.FromResult<object>(null);

        public Task<bool> MarkActivated(string serialCode) => Task.FromResult(true);
    }

    public class GizmoService : IGizmoService
    {
        private readonly IGizmoRepository _repository;

        public GizmoService(IGizmoRepository repository)
        {
            _repository = repository;
        }

        public async Task<object> GetCatalog()
        {
            return await _repository.ListAll();
        }

        public async Task<bool> Activate(string serialCode)
        {
            return await _repository.MarkActivated(serialCode);
        }
    }
}
